/* eslint-disable no-async-promise-executor */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import EventEmitter from "node:events";
import { createLogger } from "../Utilities/Logger.js";
import { amqp, clientId, discordToken, enablePrometheus, gatewayCompression, gatewayGuildPerShard, gatewayHandShakeTimeout, gatewayHelloTimeout, gatewayIntents, gatewayLargeThreshold, gatewayPresenceName, gatewayPresenceStatus, gatewayPresenceType, gatewayReadyTimeout, gatewayResume, gatewayShardCount, gatewayShardsPerWorkers, getShardCount, lokiHost, prometheusPath, prometheusPort, proxy, redisClusterScaleReads, redisClusters, redisDb, redisHost, redisNatMap, redisPassword, redisPort, redisUsername, replicaId, storeLogs } from "../config.js";
import { REST } from "@discordjs/rest";
import { CompressionMethod, SessionInfo, WebSocketManager, WebSocketShardEvents, WebSocketShardStatus } from "@discordjs/ws";
import { Util, createAmqpChannel, createRedis, RoutingKey } from "@nezuchan/utilities";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessShardingStrategy } from "../Utilities/WebSockets/ProcessShardingStrategy.js";
import { Result } from "@sapphire/result";
import { Time } from "@sapphire/time-utilities";
import APM from "prometheus-middleware";
import { GenKey } from "../Utilities/GenKey.js";
import { RabbitMQ, RedisKey } from "@nezuchan/constants";
import { Channel } from "amqplib";

const packageJson = Util.loadJSON<{ version: string }>(`file://${join(fileURLToPath(import.meta.url), "../../../package.json")}`);
const shardIds = await getShardCount();

export class NezuGateway extends EventEmitter {
    public rest = new REST({ api: proxy, rejectOnRateLimit: proxy === "https://discord.com/api" ? null : () => false });
    public logger = createLogger("nezu-gateway", clientId, storeLogs, lokiHost);

    public redis = createRedis({
        redisUsername,
        redisPassword,
        redisHost,
        redisPort,
        redisDb,
        redisClusterScaleReads,
        redisClusters,
        redisNatMap
    });

    public prometheus = new APM({
        PORT: prometheusPort,
        METRICS_ROUTE: prometheusPath
    });

    public ws = new WebSocketManager({
        buildStrategy: (manager: WebSocketManager) => new ProcessShardingStrategy(manager, {
            shardsPerWorker: gatewayShardsPerWorkers
        }),
        intents: gatewayIntents,
        helloTimeout: gatewayHelloTimeout,
        readyTimeout: gatewayReadyTimeout,
        handshakeTimeout: gatewayHandShakeTimeout,
        largeThreshold: gatewayLargeThreshold,
        token: discordToken,
        shardCount: gatewayShardCount,
        shardIds,
        initialPresence: {
            activities: [
                {
                    name: gatewayPresenceName ?? `NezukoChan Gateway v${packageJson.version}`,
                    type: gatewayPresenceType
                }
            ],
            since: gatewayPresenceStatus === "idle" ? Date.now() : null,
            status: gatewayPresenceStatus,
            afk: false
        },
        updateSessionInfo: async (shardId: number, sessionInfo: SessionInfo) => {
            const result = await Result.fromAsync(() => this.redis.set(GenKey(RedisKey.SESSIONS_KEY, String(shardId)), JSON.stringify(sessionInfo)));
            if (result.isOk()) return;
            this.logger.error(result.unwrapErr(), "Failed to update session info");
        },
        retrieveSessionInfo: async (shardId: number) => {
            if (gatewayResume) {
                const result = await Result.fromAsync(() => this.redis.get(GenKey(RedisKey.SESSIONS_KEY, String(shardId))));
                const sessionInfo = result.isOk() ? result.unwrap() : null;
                if (sessionInfo) return JSON.parse(sessionInfo) as SessionInfo;
                if (result.isErr()) this.logger.error(result.unwrapErr(), "Failed to retrieve session info");
            }
            return null;
        },
        compression: gatewayCompression ? CompressionMethod.ZlibStream : null,
        rest: this.rest
    });

    public constructor() {
        super();
        this.rest.setToken(discordToken);
    }

    public async connect(): Promise<void> {
        this.setupAmqp();
        if (enablePrometheus) this.setupPrometheus();

        this.ws.on(WebSocketShardEvents.Debug, ({ message }) => this.logger.debug(message));

        if (gatewayGuildPerShard) {
            const { shards } = await this.ws.fetchGatewayInformation(true);
            this.ws.options.shardCount = Number(Math.ceil((shards * (1_000 / Number(gatewayGuildPerShard))) / 1));
        }

        await this.ws.connect();
        const shardCount = await this.ws.getShardCount();

        // When multiple replica is running, only reset few shards statuses
        const shardStart = shardIds?.start ?? 0;
        const shardEnd = shardIds?.end ?? shardCount;

        for (let i = shardStart; i < shardEnd; i++) {
            await this.redis.set(GenKey(RedisKey.STATUSES_KEY, i.toString()), JSON.stringify({ latency: -1, status: WebSocketShardStatus.Connecting, startAt: Date.now() }));
        }

        await this.redis.set(GenKey(RedisKey.SHARDS_KEY), shardCount);
    }

    public setupAmqp() {
        const amqpChannel = createAmqpChannel(amqp, {
            setup: async (channel: Channel) => {
                await channel.assertExchange(RabbitMQ.GATEWAY_QUEUE_STATS, "topic", { durable: false });

                const { queue } = await channel.assertQueue("", { exclusive: true });

                for (const route of [RoutingKey(clientId, "*"), RoutingKey(clientId, replicaId)]) {
                    await channel.bindQueue(queue, RabbitMQ.GATEWAY_QUEUE_STATS, route);
                }

                await channel.consume(queue, async message => {
                    if (!message) return;
                    const content = JSON.parse(message.content.toString()) as { route: string };
                    const stats = [];
                    for (const [shardId, status] of await this.ws.fetchStatus()) {
                        const raw_value = await this.redis.get(GenKey(RedisKey.STATUSES_KEY, shardId.toString()));
                        const shard_status = raw_value ? JSON.parse(raw_value) as { latency: number } : { latency: -1 };
                        stats.push({ shardId, status, latency: shard_status.latency });
                    }

                    await amqpChannel.publish(RabbitMQ.GATEWAY_QUEUE_STATS, content.route, Buffer.from(
                        JSON.stringify({
                            shards: stats,
                            replicaId,
                            clientId,
                            memoryUsage: process.memoryUsage(),
                            cpuUsage: process.cpuUsage(),
                            uptime: process.uptime(),
                            shardCount: stats.length
                        })
                    ), {
                        correlationId: message.properties.correlationId
                    });
                });
            }
        });

        amqpChannel.on("error", err => this.logger.error(err, "AMQP Channel on main process Error"));
        amqpChannel.on("close", () => this.logger.warn("AMQP Channel on main process Closed"));
        amqpChannel.on("connect", () => this.logger.info("AMQP Channel handler on main process connected"));
    }

    public setupPrometheus() {
        this.prometheus.init();
        this.logger.info("Prometheus initialized");

        const guildCounter = new this.prometheus.client.Counter({
            name: "guild_count",
            help: "Guild count"
        });

        const channelCounter = new this.prometheus.client.Counter({
            name: "channel_count",
            help: "Channel count"
        });

        const socketCounter = new this.prometheus.client.Gauge({
            name: "ws_ping",
            help: "Websocket ping",
            labelNames: ["shardId"]
        });

        const sockerStatusCounter = new this.prometheus.client.Gauge({
            name: "ws_status",
            help: "Websocket status",
            labelNames: ["shardId"]
        });

        const userCounter = new this.prometheus.client.Counter({
            name: "user_count",
            help: "User count"
        });

        setInterval(async () => {
            guildCounter.reset();
            const guild = await this.redis.scard(GenKey(`${RedisKey.GUILD_KEY}${RedisKey.KEYS_SUFFIX}`));
            guildCounter.inc(guild);

            channelCounter.reset();
            const channel = await this.redis.scard(GenKey(`${RedisKey.CHANNEL_KEY}${RedisKey.KEYS_SUFFIX}`));
            channelCounter.inc(channel);

            userCounter.reset();
            const user = await this.redis.scard(GenKey(`${RedisKey.USER_KEY}${RedisKey.KEYS_SUFFIX}`));
            userCounter.inc(user);

            const shards_statuses = await this.ws.fetchStatus();

            for (const [shardId, socket] of shards_statuses) {
                sockerStatusCounter.set({ shardId }, socket);
                const status = await this.redis.get(GenKey(RedisKey.STATUSES_KEY, shardId.toString()));
                if (status) {
                    const { latency } = JSON.parse(status) as { latency: number };
                    socketCounter.set({ shardId }, latency);
                }
            }

            this.logger.debug(`Updated prometheus metrics for ${shards_statuses.size} shards in replica ${replicaId}`);
        }, Time.Second * 10);
    }
}
