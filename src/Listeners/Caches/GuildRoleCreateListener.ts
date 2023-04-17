import { Listener, ListenerContext } from "../../Stores/Listener.js";
import { GatewayDispatchEvents, GatewayGuildRoleCreateDispatch } from "discord-api-types/v10";
import { stateRoles } from "../../config.js";
import { RedisKey } from "@nezuchan/constants";
import { GenKey } from "../../Utilities/GenKey.js";

export class GuildRoleCreateListener extends Listener {
    public constructor(context: ListenerContext) {
        super(context, {
            event: GatewayDispatchEvents.GuildRoleCreate,
            enabled: stateRoles
        });
    }

    public async run(payload: { data: GatewayGuildRoleCreateDispatch }): Promise<void> {
        await this.store.redis.set(GenKey(RedisKey.ROLE_KEY, payload.data.d.role.id, payload.data.d.guild_id), JSON.stringify(payload.data.d.role));
        await this.store.redis.sadd(GenKey(`${RedisKey.ROLE_KEY}${RedisKey.KEYS_SUFFIX}`, payload.data.d.guild_id), GenKey(RedisKey.ROLE_KEY, payload.data.d.role.id, payload.data.d.guild_id));
    }
}
