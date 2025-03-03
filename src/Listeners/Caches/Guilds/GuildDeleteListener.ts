import { Listener, ListenerContext } from "../../../Stores/Listener.js";
import { GatewayDispatchEvents, GatewayGuildDeleteDispatch } from "discord-api-types/v10";
import { RabbitMQ, RedisKey } from "@nezuchan/constants";
import { RoutingKey, redisSScanStreamPromise } from "@nezuchan/utilities";
import { GenKey } from "../../../Utilities/GenKey.js";
import { clientId } from "../../../config.js";

export class GuildDeleteListener extends Listener {
    public constructor(context: ListenerContext) {
        super(context, {
            event: GatewayDispatchEvents.GuildDelete
        });
    }

    public async run(payload: { data: GatewayGuildDeleteDispatch; shardId: number }): Promise<void> {
        const old = await this.store.redis.get(GenKey(RedisKey.GUILD_KEY, payload.data.d.id));
        const old_parsed = old ? JSON.parse(old) : {};

        const roles = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.ROLE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);
        const channels = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.CHANNEL_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);
        const members = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.MEMBER_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);
        const emojis = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.EMOJI_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);
        const presences = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.PRESENCE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);
        const voiceStates = await redisSScanStreamPromise(this.store.redis, GenKey(`${RedisKey.VOICE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id), "*", 1000);

        for (const role of roles) {
            await this.store.redis.unlink(role);
        }

        for (const channel of channels) {
            await this.store.redis.unlink(channel);
        }

        for (const member of members) {
            await this.store.redis.unlink(member);
        }

        for (const emoji of emojis) {
            await this.store.redis.unlink(emoji);
        }

        for (const presence of presences) {
            await this.store.redis.unlink(presence);
        }

        for (const voiceState of voiceStates) {
            await this.store.redis.unlink(voiceState);
        }

        await this.store.redis.unlink(GenKey(RedisKey.GUILD_KEY, payload.data.d.id));
        await this.store.redis.srem(GenKey(`${RedisKey.GUILD_KEY}${RedisKey.KEYS_SUFFIX}`), GenKey(`${RedisKey.GUILD_KEY}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.ROLE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.CHANNEL_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.MEMBER_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.EMOJI_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.PRESENCE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));
        await this.store.redis.unlink(GenKey(`${RedisKey.VOICE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.id));

        await this.store.amqp.publish(RabbitMQ.GATEWAY_QUEUE_SEND, RoutingKey(clientId, payload.shardId), Buffer.from(JSON.stringify({
            ...payload.data,
            old: {
                roles,
                channels,
                members,
                emojis,
                presences,
                voiceStates,
                ...old_parsed
            }
        })));
    }
}
