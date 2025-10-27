import {
    remote,
    ServerSession,
    UnknownFunction,
    isClientCallback,
    ClientCallback,
    withTrim,
    SocketAssociatedCallbackFunction
} from "../ServerSession";
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

    /**
     * Trim the arguments when doing the call / callForSure. See {@link RemoteMethodOptions#trimArguments} for an explanation, what trimming means.
     */
    trimArguments= false;

    /**
     * Additional to {@link trimArguments}.
     * See The {@link withTrim} function's useSignatureFrom parameter for a description.
     */
    trimFromSignature?: UnknownFunction;

    /**
     * Configures every callback, that is added, to skip outdated calls
     * Default: false
     * TODO: implement
     */
    skipOutdated?: boolean

    /**
     * In case a client has missed some events during a disconnect phase, the client can still keep up.
     * Default: 0
     * TODO: implement
     */
    keepLast?: number

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

    /**
     * Calls the specified callbacks. Does not wait for the result. Ignores disconnects and errors.
     * @param callbacks
     * @param args
     */
    _call(callbacks: Set<ClientCallback>, args: PARAMS) {
        function preventUnhandledRejection(maybePromise: unknown) {
            if(maybePromise != null && maybePromise instanceof Promise) {
                maybePromise.catch(() => {})
            }
        }

        callbacks.forEach(cb => {
            if(isClientCallback(cb)) {
                preventUnhandledRejection(
                    cb._validateAndCall(args, this.trimArguments, false, this.trimFromSignature, { isFromClientCallbacks: true, isFromClientCallbacks_CallForSure: false})
                );
            }
            else {
                preventUnhandledRejection(
                    cb(...args)
                );
            }
        });
    }

    /**
     * Waits, till all listeners have been called and finished. Use, when you rely on the clients, so not on a public web server or when working with other that ClientCallback functions.
     * @param entity
     * @param args
     */
    async _callForSure(callbacks: Set<ClientCallback>, args: PARAMS): Promise<void> {
        // Validity check
        if(this.removeOnDisconnect === undefined) {
            throw new Error("When using callForSure, you must explicitly define the removeOnDisconnect field in the ClientCallbackSetOptions. Usually, you'll want to set it to false.");
        }

        for(const cb of callbacks) {
            if(isClientCallback(cb)) {
                // TODO: check that cb.skippable is disabeld
                await cb._validateAndCall(args, this.trimArguments, false, this.trimFromSignature, {isFromClientCallbacks: true, isFromClientCallbacks_CallForSure: true});
            }
            else {
                await cb(...args);
            }
        }


    }

    checkIsSocketAssociatedCallbackFunction(fn: any) {
        if(typeof fn !== "function") {
            throw new Error("The passed argument is not a function.")
        }
        if(! ((fn as SocketAssociatedCallbackFunction).socketConnection)) {
            throw new Error("The passed argument is not a client callback function (or at least associated to a SocketConnection).")
        }
        return fn as ClientCallback;
    }
}


export type ClientCallbackSetOptions = Partial<Pick<ClientCallbacksSetCommon<any>, "removeOnDisconnect" | "freeOnClientImmediately" | "maxListenersPerClient" | "trimArguments" | "trimFromSignature">>