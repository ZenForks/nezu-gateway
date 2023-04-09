/* eslint-disable class-methods-use-this */
import { GatewayDispatchEvents, GatewayUserUpdateDispatch } from "discord-api-types/v10";
import { Listener, ListenerOptions } from "../Stores/Listener.js";
import { RedisKey } from "@nezuchan/constants";
import { ApplyOptions } from "../Utilities/Decorators/ApplyOptions.js";

@ApplyOptions<ListenerOptions>(({ container }) => ({
    name: GatewayDispatchEvents.UserUpdate,
    emitter: container.gateway
}))

export class UserUpdateListener extends Listener {
    public async run(payload: { data: GatewayUserUpdateDispatch }): Promise<void> {
        this.container.gateway.amqp.sender.publish(this.container.gateway.clientId, payload.data.t, payload, { persistent: false });
        await this.container.gateway.redis.set(this.container.gateway.genKey(RedisKey.BOT_USER_KEY, false), JSON.stringify(payload.data.d));
    }
}
