import {remote, ServerSession, UnknownFunction, isClientCallback, ClientCallback, withTrim} from "../ServerSession";
import _ from "underscore"

/**
 * Common stuff for both ClientCallbackSet + ClientCallbackSetPerItem classes
 */
export class ClientCallbacksSetCommon<PARAMS extends unknown[]> {

    /**
     * Removes the callbacks / unused items when the client disconnects. You want to disable this usually only when using the callForSure method.
     * <p>
     * Default: true
     * </p>
     */
    removeOnDisconnect: boolean | undefined = undefined;

    /**
     * Advanced: Immediately reports to the client that the listeners are not used anymore after the remove... method. Otherwise this is done after a while after garbage collection.
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
    constructor(options?: ClientCallbackSetOptions) {
        if(options) {
            //@ts-ignore
            _.extend(this, options);
        }
    }

    _call(callbacks: Set<ClientCallback>, args: PARAMS) {
        callbacks.forEach(cb => cb._validateAndCall(args, this.trimArguments, false, this.trimFromSignature, {isFromClientCallbacks: true, isFromClientCallbacks_CallForSure: false}));
    }

    /**
     * Waits, till all listeners have been called and finished. Use, when you rely on the clients, so not on a public web server.
     * @param entity
     * @param args
     */
    async _callForSure(callbacks: Set<ClientCallback>, args: PARAMS): Promise<void> {
        // Validity check
        if(this.removeOnDisconnect === undefined) {
            throw new Error("When using callForSure, you must explicitly define the removeOnDisconnect field in the ClientCallbackSetOptions. Usually, you'll want to set it to false.");
        }

        for(const cb of callbacks) {
            // TODO: check that cb.skippable is disabeld
            await cb._validateAndCall(args, this.trimArguments, false, this.trimFromSignature, {isFromClientCallbacks: true, isFromClientCallbacks_CallForSure: true});
        }


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


export type ClientCallbackSetOptions = Partial<Pick<ClientCallbacksSetCommon<any>, "removeOnDisconnect" | "freeOnClientImmediately" | "maxListenersPerClient" | "trimArguments" | "trimFromSignature">>