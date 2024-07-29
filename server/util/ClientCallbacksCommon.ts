import {remote, ServerSession, UnknownFunction, isClientCallback, ClientCallback, withTrim} from "../ServerSession";
import {EventEmitter} from "node:events"
import _ from "underscore"

/**
 * Common stuff for both ClientCallbacks + ClientCallbacksForEntities classes
 */
export class ClientCallbacksCommon<PARAMS extends unknown[]> {

    /**
     * Should the {@link #emitForSure} method allow, that a client has (silently) disconnected without calling removeListener ? Otherwise an error is thrown.
     * Enabling this will result in not freeing up unused topics (event-types).
     */
    emitForSureAllowsDisconnect: boolean | undefined = undefined;

    /**
     * Advanced: Immediately reports to the client that the listeners are not used anymore after the remove.../once... methods. Otherwise this is done after a while after garbage collection.
     * Only enable this, when having trouble with memory consumption on the client and when using the listeners exclusively.
     */
    freeOnClientImmediately = false;

    /**
     * Undefined = unlimited (default)
     */
    maxListenersPerClient?: number;

    trimArguments= false;
    trimFromSignature?: UnknownFunction;

    /**
     *
     * @param options
     */
    constructor(options?: ClientCallbacksOptions) {
        if(options) {
            //@ts-ignore
            _.apply(this, options);
        }
    }

    _call(callbacks: Set<ClientCallback>, args: PARAMS) {
        callbacks.forEach(cb => cb._validateAndCall(args, this.trimArguments, false, this.trimFromSignature, {isFromClientCallbacks: true}));
    }

    /**
     * Waits, till all listeners have been called and finished. Use, when you rely on the clients, so not on a public web server.
     * @param entity
     * @param args
     */
    async _callForSure(callbacks: Set<ClientCallback>, args: PARAMS): Promise<void> {
        // Validity check
        if(this.emitForSureAllowsDisconnect === undefined) {
            throw new Error("When using emitForSure, you must explicitly define the emitForSureAllowsDisconnect parameter in the EventEmitter options. Usually, you'll want to set it to false.");
        }

        // TODO: check that listener.skippable is disabeld
    }

    checkIsValidClientCallback(fn: any) {
        if(typeof fn !== "function") {
            throw new Error("The passed argument is not a function.")
        }
        if(!isClientCallback(fn)) {
            throw new Error("The passed argument is not a client callback function.")
        }
        return fn as ClientCallback;
    }
}


export type ClientCallbacksOptions = Partial<Pick<ClientCallbacksCommon<any>, "emitForSureAllowsDisconnect" | "freeOnClientImmediately" | "maxListenersPerClient" | "trimArguments" | "trimFromSignature">>

export interface ClientCallback_CleanupInterface {

}