import {Request, Response} from "express";
import _ from "underscore";
import {RestError, RestfuncsOptions} from "./index";
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {Camelize, diagnisis_shortenValue, enhanceViaProxyDuringCall} from "./Util";

function diagnosis_isAnonymousObject(o: object) {
    if(o.constructor?.name === "Object") {
        return true;
    }

    return false;
}

export function isTypeInfoAvailable(restService: object) {
    const r = reflect(restService);

    // *** Some heuristic checks: (the rtti api currently has no really good way to check it)
    // TODO: improve checks for security reasons !

    /*
    if(r.methods.length === 0) {
        return false;
    }
    // Still this check was not enough because we received  the methods of the prototype
    */

    if(r.getProperty("xxyyyyzzzzzdoesntExist") !== undefined) { // non existing property reported as existing ?
        return false;
    }

    return true
}


/**
 * Throws an exception if you're not allowed to call the method from the outside
 * @param reflectedMethod
 */
function checkMethodAccessibility(reflectedMethod: ReflectedMethod) {
    if(reflectedMethod.isProtected) {
        throw new RestError("Method is protected.")
    }
    if(reflectedMethod.isPrivate) {
        throw new RestError("Method is private.")
    }

    // The other blocks should have already caught it. But just to be safe for future language extensions we explicitly check again:
    if(reflectedMethod.visibility !== "public") {
        throw new RestError("Method is not public")
    }
}

/**
 * Throws an exception if args does not match the parameters of reflectedMethod
 * @param reflectedMethod
 * @param args
 */
export function checkParameterTypes(reflectedMethod: ReflectedMethod, args: Readonly<any[]>) {
    // Make a stack out of args so we can pull out the first till the last. This wqy we can deal with ...rest params
    let argsStack = [...args]; // shallow clone
    argsStack.reverse();

    const errors: string[] = [];
    function validateAndCollectErrors(parameter: ReflectedMethodParameter, arg: any) {
        const collectedErrorsForThisParam: Error[] = [];
        const ok = parameter.type.matchesValue(arg, collectedErrorsForThisParam); // Check value
        if (!ok || collectedErrorsForThisParam.length > 0) {
            errors.push(`Invalid value for parameter ${parameter.name}: ${diagnisis_shortenValue(arg)}${collectedErrorsForThisParam.length > 0?`. Reason: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`:""}`);
        }
    }

    for(const i in reflectedMethod.parameters) {
        const parameter = reflectedMethod.parameters[i];
        if(parameter.isOmitted) {
            throw new RestError("Omitted arguments not supported")
        }
        if(parameter.isRest) {
            argsStack.reverse();

            validateAndCollectErrors(parameter, argsStack);

            argsStack = [];
            continue;
        }
        if(parameter.isBinding) {
            throw new RestError(`Runtime typechecking of destructuring arguments is not yet supported`)
        }

        const arg =  argsStack.length > 0?argsStack.pop():undefined;

        // Allow undefined for optional parameter:
        if(parameter.isOptional && arg === undefined) {
            continue;
        }

        validateAndCollectErrors(parameter, arg);
    }

    if(argsStack.length > 0) {
        throw new RestError(`Too many arguments. Expected ${reflectedMethod.parameters.length}, got ${args.length}`)
    }

    if(errors.length > 0) {
        throw new RestError(errors.join("; "))
    }
}


export type RegularHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ParameterSource = "string" | "json" | null; // Null means: Cannot be auto converted
/**
 * Service base class. Extend it and use {@see restfuncs} on it.
 */
export class RestService {
    [index: string]: any

    /**
     * Lists the methods that are flagged as @safe
     * filled on annotation loading: for each concrete subclass such a static field is created
     */
    static safeMethods?: Set<string>

    /**
     * The currently running (express) request. See https://expressjs.com/en/4x/api.html#req
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
        // @ts-ignore // TODO: make req | null in 1.0 API
    protected req!: Request = null;

    /**
     * Response for the currently running (express) request. You can modify any header fields as you like. See https://expressjs.com/en/4x/api.html#res
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
        // @ts-ignore // TODO: make req | null in 1.0 API
    protected resp!: Response = null;


    /**
     * The browser/client session (for the currently running request). You can add any user defined content to it.
     * What you set as initial value here will also be the initial value of EVERY new session. Note that this initial session is not deeply cloned.
     *
     * When restfuncs is used with express, you must install the session handler in express yourself (follow the no-sessionhandler errormessage for guidance).
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected session: {} | null = {};

    /**
     * @return The / index- / home page
     */
    @safe()
    getIndex() {
        // TODO: implement
    }


    /**
     * Security checks the method name and args and executes the methods call.
     * @param evil_methodName
     * @param evil_args
     * @param enhancementProps These fields will be temporarily added to this during the call.
     * @param options
     */
    public async validateAndDoCall(evil_methodName: string, evil_args: any[], enhancementProps: Partial<this>, options: RestfuncsOptions): Promise<any> {

        // typing was only for the caller. We go back to "any" so must check again:
        const methodName = <any> evil_methodName;
        const args = <any> evil_args;

        // Check methodName:
        if(!methodName) {
            throw new RestError(`methodName not set`)
        }
        if(typeof methodName !== "string") {
            throw new RestError(`methodName is not a string`)
        }
        if(new (class extends RestService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
            throw new RestError(`You are trying to call a remote method that is a reserved name: ${methodName}`)
        }
        if(this[methodName] === undefined) {
            throw new RestError(`You are trying to call a remote method that does not exist: ${methodName}`)
        }
        const method = this[methodName];
        if(typeof method != "function") {
            throw new RestError(`${methodName} is not a function`)
        }

        // Make sure that args is an array:
        if(!args || args.constructor !== Array) {
            throw new RestError("args is not an array")
        }

        // Runtime type checking of args:
        if(options.checkArguments || (options.checkArguments === undefined && isTypeInfoAvailable(this))) { // Checking required or available ?
            const reflectedMethod = reflect(this).getMethod(methodName); // we could also use reflect(method) but this doesn't give use params for anonymous classes - strangely'
            checkMethodAccessibility(<ReflectedMethod> reflectedMethod);
            checkParameterTypes(<ReflectedMethod> reflectedMethod,args);
        }

        // Check enhancementProps (for the very paranoid):
        if(!enhancementProps || typeof enhancementProps !== "object" || _.functions(enhancementProps).length > 0) {
            throw new Error("Invalid enhancementProps argument");
        }
        const allowed: Record<string, boolean> = {req:true, resp: true, session: true}
        Object.keys(enhancementProps).map(key => {if(!allowed[key]) { throw new Error(`${key} not allowed in enhancementProps`)}})

        let result;
        await enhanceViaProxyDuringCall(this, enhancementProps, async (restService) => { // make .req and .resp safely available during call
            result = await restService.doCall(methodName, args); // Call method with user's doCall interceptor;
        }, methodName);

        return result
    }

    /**
     * Allows you to intercept calls. Override and implement it with the default body:
     * <pre><code>
     *      return  await this[funcName](...args) // Call the original function
     * </code></pre>
     *
     * You have access to this.req, this.resp and this.session as usual.
     *
     * @param funcName name of the function to be called
     * @param args args of the function to be called
     */
    protected async doCall(funcName: string, args: any[]) {
        return await this[funcName](...args) // Call the original function
    }


    /**
     * You can override this as part of the API
     * @param query i.e. book=1984&author=George%20Orwell&keyWithoutValue
     * @return I.e. {
     *      result: {book: "1984", author="George Orwell", keyWithoutValue:"true"}
     *      containsStringValuesOnly: true // decides, which of the autoConvertValueForParameter_... methods is used.
     * }
     */
    parseQuery(query: string): {result: Record<string, any>|any [], containsStringValuesOnly: boolean} {
        // Query is a list i.e: "a,b,c" ?
        if(query.indexOf(",") > query.indexOf("=")) { // , before = means, we assume it is a comma separated list
            return {
                result: query.split(",").map( value => decodeURIComponent(value)),
                containsStringValuesOnly: true
            };
        }
        else if(query.indexOf("=") > 0 || query.indexOf("&") > -1){ // Query is a map (named) ?
            const result: Record<string, string> = {};
            const tokens = query.split("&");
            for (const token of tokens) {
                if (!token) {
                    continue;
                }
                if (token.indexOf("=") > -1) {
                    const [key, value] = token.split("=");
                    if (key) {
                        result[decodeURIComponent(key)] = decodeURIComponent(value);
                    }
                } else {
                    result[decodeURIComponent(token)] = "true";
                }
            }
            return {result, containsStringValuesOnly: true};
        }
        else {
            return {result: [decodeURIComponent(query)], containsStringValuesOnly: true}; // Single element
        }
    }

    /**
     * You can override this as part of the API
     * @param methodName method/function name
     * @see RestfuncsOptions.allowGettersFromAllOrigins
     * @return Whether the method is [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), i.e., performs *read-only* operations only !
     */
    public methodIsSafe(methodName: string) {

        if(this[methodName] === RestService.prototype[methodName]) { // Method was unmodifiedly taken from the RestService mixin. I.e. "getIndex". See RestService.initializeRestService(). ?
            return methodIsMarkedSafeAtActualImplementationLevel(RestService, methodName); // Look at RestService level
        }

        if(!this.constructor) { // No class ?
            return false; // Non-classes can't have @decorators.
        }

        return methodIsMarkedSafeAtActualImplementationLevel(this.constructor, methodName);
    }

    /**
     * You can override this as part of the API
     * @param methodName
     */
    public hasMethod(methodName: string) {
        return this[methodName] && (typeof this[methodName] === "function");
    }

    /**
     * Retrieves, which method should be picked. I.e GET user -> getUser
     *
     * You can override this as part of the API
     * @param httpMethod
     * @param path the path portion that should represents the method name. No "/"s contained. I.e. "user" (meaning getUser or user)
     */
    public getMethodNameForCall(httpMethod: RegularHttpMethod, path: string): string | null {
        if (this.hasMethod(path)) { // Direct hit
            return path; // We are done and don't lose performance on other checks
        }

        // check: GET user -> getUser
        {
            const candidate = `${httpMethod.toLowerCase()}${Camelize(path)}`;
            if (this.hasMethod(candidate)) {
                return candidate;
            }
        }


        if (httpMethod === "PUT") {
            // check: PUT user -> updateUser
            {
                const candidate = `update${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }

            // check: PUT user -> setUser
            {
                const candidate = `set${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }
        }

        return null;
    }

    /**
     * @see #autoConvertValueForParameter_fromString
     * @see #autoConvertValueForParameter_fromJson
     */
    public autoConvertValueForParameter(value: any, parameter: ReflectedMethodParameter, source: ParameterSource): any {
        if(source === "string") {
            if(typeof value !== "string") {
                throw new Error(`${parameter.name} parameter should be a string`)
            }
            return this.autoConvertValueForParameter_fromString(value, parameter);
        }
        else if(source === "json") {
            return this.autoConvertValueForParameter_fromJson(value, parameter);
        }
        else {
            // TODO: Auto convert Buffers into strings
            return value;
        }
    }

    protected static STRING_TO_BOOL_MAP: Record<string, boolean | undefined> = {
        "true": true,
        "false": false,
        // "1": true, "0": false // Nah -> we should keep the door open for number|bool auto conversion
        "": undefined
    }

    /**
     * Values from the url path or the query are plain strings only.
     * This method is called to convert them to the actual needed parameter type.
     * If it doesn't know how to convert it, the value is returned as is. The validity/security is checked at a later stage again.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromString(value: string, parameter: ReflectedMethodParameter): any {
        // TODO: number|bool and other ambiguous types could be auto converted to
        try {
            if (parameter.type.isClass(Number)) {
                if (value === "") {
                    return undefined;
                }
                if (value === "NaN") {
                    return Number.NaN
                }
                const result = Number(value);
                if(Number.isNaN(result)) { // Invalid values were converted to NaN but we don't want that.
                    return value;
                }
                return result;
            }

            if (parameter.type.isClass(BigInt)) {
                if (value === "") {
                    return undefined;
                }
                return BigInt(value);
            }

            if (parameter.type.isClass(Boolean)) {
                return RestService.STRING_TO_BOOL_MAP[value];
            }

            if (parameter.type.isClass(Date)) {
                if (value === "") {
                    return undefined;
                }
                return new Date(value);
            }

            return value;
        }
        catch (e) {
            throw new RestError(`Error converting value ${value} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a RestError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Fixes values that were passed in the request body (json) to the actual needed parameter type.
     *
     * Currently this is only for Date objects, since json lacks of representing these.
     * Other values (i.e. parameter needs Number but value is a string) will be left untouched, so they will produce the right error message at the later validity/security checking stage.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromJson(value: any, parameter: ReflectedMethodParameter): any {
        // *** Help us make this method convert to nested dates like myFunc(i: {someDate: Date})
        // *** You can use [this nice little playground](https://typescript-rtti.org) to quickly see how the ReflectedMethodParameter works ;)
        try {
            // null -> undefined
            if (value === null && !parameter.type.matchesValue(null) && (parameter.isOptional || parameter.type.matchesValue(undefined))) { // undefined values were passed as null (i.e. an parameter array [undefined] would JSON.stringify to [null] TODO: whe should only check this if we came from an array to lessen magic / improve security
                return undefined;
            }

            if (parameter.type.isClass(BigInt) && typeof value === "number") {
                return BigInt(value);
            }

            if (parameter.type.isClass(Date) && typeof value === "string") {
                return new Date(value);
            }

            return value;
        }
        catch (e) {
            throw new RestError(`Error converting value ${diagnisis_shortenValue(value)} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a RestError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Lists (potentially) callable methods
     * Warning: Not part of the API ! Unlisting a method does not prevent it from beeing called !
     */
    public listCallableMethods() {
        const protoRestService = new (class extends RestService{})();

        return reflect(this).methodNames.map(methodName => reflect(this).getMethod(methodName)).filter(reflectedMethod => {
            if (protoRestService[reflectedMethod.name] !== undefined || {}[reflectedMethod.name] !== undefined) { // property exists in an empty service ?
                return false;
            }

            try {
                checkMethodAccessibility(<ReflectedMethod>reflectedMethod);
                return true;
            }
            catch (e) {
            }
            return false;
        })
    }

    public mayNeedFileUploadSupport() {
        // Check if this service has methods that accept buffer

        const someBuffer = new Buffer(0);
        return _.find(this.listCallableMethods(), reflectMethod => {
            return _.find(reflectMethod.parameters, param => {
                if(param.type.isAny()) {
                    return false;
                }

                return param.type.matchesValue(someBuffer) ||
                    (param.isRest && param.type.matchesValue([someBuffer]))
            }) !== undefined;
        }) !== undefined;
    }

    /**
     * Internal
     * @private
     */
    _sessionPrototype?: object;

    /**
     * Internal: Must be called by every adapter (i.e. express) before the service is used.
     * @param restServiceObj
     * @param options
     */
    public static initializeRestService(restServiceObj: object, options: RestfuncsOptions): RestService {
        /**
         * Nonexisting props and methods get copied to the target so that it's like the target exends the base class .
         * @param target
         * @param base
         */
        function baseOn(target: {[index: string]: any }, base: {[index: string]: any }) {
            [...Object.keys(base), ..._.functions(base)].map(propName => {
                if(target[propName] === undefined) {
                    target[propName] = base[propName];
                }
            })
        }


        if(!(restServiceObj instanceof RestService)) {
            baseOn(restServiceObj, new RestService());
        }

        const restService = <RestService> restServiceObj;

        restService._sessionPrototype = restService.session || {}; // The user maybe has some initialization code for his session: Ie. {counter:0}  - so we want to make that convenient
        // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
        // @ts-ignore
        restService.req = null; restService.resp = null; restService.session = null;

        // Warn/error if type info is not available:
        if(!isTypeInfoAvailable(restService)) {
            if(options.checkArguments) {
                throw new RestError("Runtime type information is not available.\n" +  restService._diagnosisWhyIsRTTINotAvailable())
            }
            else if(options.checkArguments === undefined) {
                console.warn("**** SECURITY WARNING: Runtime type information is not available. This can be a security risk as your func's arguments cannot be checked automatically !\n" + restService._diagnosisWhyIsRTTINotAvailable())
            }
        }

        return restService;
    }

    public _diagnosisWhyIsRTTINotAvailable() {
        return diagnosis_isAnonymousObject(this) ? "Probably this is because your service is an anonymous object and not defined as a class." : "To enable runtime arguments typechecking, See https://github.com/bogeeee/restfuncs#runtime-arguments-typechecking-shielding-against-evil-input";
    }
}

/**
 *
 * Flag your function with this decorator as [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), if you are sure it essentially performs only *read* operations.
 *
 * This flag is needed to allow for some cases where cross site security can't be checked otherwise. i.e:
 *   - A function that serves a html page so it should be accessible by top level navigation (i.e from a bookmark or an email link) as these don't send an origin header.
 *   - functions that serve an image publicly to all origins.
 *
 *
 * @example
 * <pre>
 *     import {safe} from "restfuncs-server";
 *
 *     @safe
 *     function getUserStatusPage() {
 *         //... perform non-state-changing operations only
 *         // TODO set content type header
 *         return `<html>
 *             isLoggedOn: ${isLoggedOn},
 *             yourLibraryKey: ${escapeHtml(xy)} // You can still send sensitive information because a browser script from a non allowed origins can't extract the contents of simple/non-preflighted GET requests
 *         </html>`;
 *     }
 * </pre>
 */
export function safe() {
    return function (target: any, methodName: string, descriptor: PropertyDescriptor) {
        const constructor = target.constructor;
        if(!Object.getOwnPropertyDescriptor(constructor,"safeMethods")?.value) { // constructor does not have it's OWN .safeMethods initialized yet ?
            constructor.safeMethods = new Set<string>();
        }

        constructor.safeMethods.add(methodName);
    };
}

/**
 * Meaning, if an overwritten method does not also explicitly have @safe, it's not considered safe
 * @param classConstructor
 * @param methodName
 * @return true if the method was decorated @safe at this
 */
function methodIsMarkedSafeAtActualImplementationLevel(classConstructor: Function, methodName: string): boolean {
    if(!classConstructor.prototype) { // Don't know / unhandled
        return false;
    }

    if(classConstructor.prototype.hasOwnProperty(methodName)) { // Method defined at this level ?
        // Check that is was decorated @safe at this level:
        // @ts-ignore
        const safeMethods = <Set<string>> classConstructor?.safeMethods;

        return safeMethods !== undefined && safeMethods.has(methodName);
    }

    // Check at parent level
    const baseConstructor = Object.getPrototypeOf(classConstructor);
    if(baseConstructor) {
        return methodIsMarkedSafeAtActualImplementationLevel(baseConstructor, methodName);
    }

    return false;
}

/**
 * To hin with error messages
 * @param constructor
 * @param methodName
 */
function diagnosis_methodWasDeclaredSafeAtAnyLevel(constructor: Function, methodName: string): boolean {
    if(!constructor) {
        return false;
    }

    // @ts-ignore
    const safeMethods = <Set<string>> constructor?.safeMethods;

    return safeMethods !== undefined && safeMethods.has(methodName);

    // Check at parent level
    const baseConstructor = Object.getPrototypeOf(constructor);
    if(baseConstructor) {
        return diagnosis_methodWasDeclaredSafeAtAnyLevel(baseConstructor, methodName);
    }

    return false;
}