import { Listener, ListenerContext } from "../../../Stores/Listener.js";
import { GatewayGuildMemberAddDispatch, GatewayDispatchEvents } from "discord-api-types/v10";
import { clientId, stateMembers, stateUsers } from "../../../config.js";
import { RabbitMQ, RedisKey } from "@nezuchan/constants";
import { GenKey } from "../../../Utilities/GenKey.js";
import { RoutingKey } from "@nezuchan/utilities";

export class GuildMemberAddListener extends Listener {
    public constructor(context: ListenerContext) {
        super(context, {
            event: GatewayDispatchEvents.GuildMemberAdd
        });
    }

    public async run(payload: { data: GatewayGuildMemberAddDispatch; shardId: number }): Promise<void> {
        if (stateUsers) {
            await this.store.redis.set(GenKey(RedisKey.USER_KEY, payload.data.d.user!.id), JSON.stringify(payload.data.d.user));
            await this.store.redis.sadd(GenKey(`${RedisKey.USER_KEY}${RedisKey.KEYS_SUFFIX}`), GenKey(RedisKey.USER_KEY, payload.data.d.user!.id));
        }

        if (stateMembers) {
            await this.store.redis.set(GenKey(RedisKey.MEMBER_KEY, payload.data.d.user!.id, payload.data.d.guild_id), JSON.stringify(payload.data.d));
            await this.store.redis.sadd(GenKey(`${RedisKey.MEMBER_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.guild_id), GenKey(RedisKey.MEMBER_KEY, payload.data.d.user!.id, payload.data.d.guild_id));
        }

        await this.store.amqp.publish(RabbitMQ.GATEWAY_QUEUE_SEND, RoutingKey(clientId, payload.shardId), Buffer.from(JSON.stringify(payload.data)));
    }
}
