import 'reflect-metadata'
import {ClientCallback, ClientCallbackOptions, ServerSession as ServerSession} from "restfuncs-server/ServerSession";
import express from "express";
import {reflect} from "typescript-rtti";
import {extendPropsAndFunctions, isTypeInfoAvailable} from "restfuncs-server/Util";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";
import {develop_resetGlobals} from "restfuncs-server/Server";
import {remote, restfuncsExpress, ServerSessionOptions} from "restfuncs-server";
import {ServerPrivateBox, WelcomeInfo} from "restfuncs-common";
import {runClientServerTests, standardOptions} from "./lib";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

const INVALID_ARGUMENTS_MESSAGE = /Invalid argument/;
const INVALID_RETURN_MESSAGE = /returned an invalid value/;


beforeEach(() => {
    develop_resetGlobals();
});

class TypecheckingService extends ServerSession {
    static options: ServerSessionOptions = {...standardOptions, devDisableSecurity: false, logErrors: false, exposeErrors: true }
}


async function expectAsyncFunctionToThrow(f: (...any) => any, expected?: string | RegExp | Error | jest.Constructable) {
    let caught = null;
    try {
        const result = await f();
    }
    catch (e) {
        caught = e;
    }

    expect( () => {
        if(caught) {
            throw caught;
        }
    }).toThrow(expected);
}

test('Test if if rtti is available', async () => {
    class User {
        id : number;
        username? : string;
        protected favoriteColor? : number | string;
        doIt() { return 123; }
    }

    const reflectedClass = reflect(User);

    expect(reflectedClass.getProperty("xxx")).toBeUndefined(); // seeing this error means, we get a value for ANY nonexisting property. The compilation process does not work properly

    expect(reflectedClass
        .getProperty('favoriteColor')
        .type.is('union')).toBe(true);

    expect(isTypeInfoAvailable(new class {
    })).toBeTruthy();
});

test('Test arguments', async () => {
    class ServerAPI extends TypecheckingService{
        @remote()
        myVoidMethod() {
        }

        @remote()
        params1(x: string) {
        }

        @remote()
        params2(x: string, y: number, z: {}) {
        }

        @remote()
        setObjWithValues(z: {prop1: boolean}) {
        }

        @remote()
        withOptionalArgument(my?: string) {

        }

        @remote()
        withUndefined(my: string | undefined) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.myVoidMethod();
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myVoidMethod("illegalParam"), /Too many arguments|invalid number of arguments/);

            await apiProxy.params1("ok");

            // Too many arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), /Too many arguments|invalid number of arguments/);

            // To few arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1(), INVALID_ARGUMENTS_MESSAGE);

            // With objects:
            await apiProxy.params2("ok", 123, {});

            await apiProxy.setObjWithValues({prop1: true});

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: 123}), /expected.*boolean/i );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({}), INVALID_ARGUMENTS_MESSAGE );

            await apiProxy.withOptionalArgument()
        }
    );
})

test('Test arguments with deep undefined', async () => {
    class ServerAPI extends TypecheckingService{
        @remote()
        withDeepUndefined(my: {deep: string | undefined}) {

        }

        @remote()
        withDeepOptional(my: {deep?: string}) {

        }


    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.withDeepUndefined({deep: undefined})
            await apiProxy.withDeepOptional({})
        }
    );
})

test('User defined classes', async () => {
    class User {
        name: string
        someMethod() {}
    }

    class ServerAPI extends TypecheckingService{
        @remote()
        getObject(value: User): any {
            return value
        }

        @remote()
        returnUser(): any {
            const user = new User();
            user.name="someone"
            return user
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expect(await apiProxy.getObject({name: "bob"} as User)).toStrictEqual({name: "bob"}) // Expect it to work like this. But still questionable if it should be allowed in general
            expect(await apiProxy.returnUser()).toStrictEqual({name: "someone"});
        }
    );
})

test('Test arguments - extra properties value / trim arguments', async () => {

    type IUser=  {
        name: string,
        age: number,
        password: string,
    }

    class ServerAPI extends ServerSession{
        @remote()
        params1(x: string, y: number, z: {}): any {
            return z;
        }

        @remote({trimArguments: false})
        params2(x: string, y: number, z: {}) {
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expect( (await apiProxy.params1("ok", 123, {someExtraProperty: true})).someExtraProperty).toBeUndefined();
            await expectAsyncFunctionToThrow( async () => {await apiProxy.params2("ok", 123, {someExtraProperty: true});}, INVALID_ARGUMENTS_MESSAGE);
        }
    );
})

test('trim result', async () => {

    type IUser=  {
        name: string,
        age: number,
        password: string,
        sub?: {
            subExtra: string
        }
    }

    class ServerAPI extends ServerSession {

        @remote({trimResult: false})
        doesntTrimResult(): {} {
            return {extra: true}
        }

        @remote()
        trimResult(): {} {
            return {extra: true}
        }

        @remote()
        async trimResultAsync(): Promise<{}> {
            return {extra: true}
        }

        @remote()
        trimResultImplicit() {
            return {extra: true} as {}
        }

        @remote()
        trimResultWithPick(): Pick<IUser, "name" | "age"> { // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        trimResultWithOmit(): Omit<IUser, "password">{  // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        trimResultWithOmitWithSub(): Omit<IUser, "password" | "sub"> & {sub: Omit<IUser["sub"], "extra">} {
            const user = {name: "Franz", age: 45, password: "geheim!", sub: {subExtra: "extra"}}
            return user;
        }

        @remote({trimResult: false})
        returnAny(): any {
            return {extra: true}
        }

        @remote({trimResult: false})
        returnUnknown(): unknown {
            return {extra: true}
        }


    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expectAsyncFunctionToThrow(apiProxy.doesntTrimResult, /invalid.*extra/);
            expect(await apiProxy.trimResult()).toStrictEqual({});
            expect(await apiProxy.trimResultAsync()).toStrictEqual({});
            expect(await apiProxy.trimResultImplicit()).toStrictEqual({});
            expect(await apiProxy.trimResultWithPick()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.trimResultWithOmit()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.trimResultWithOmitWithSub()).toStrictEqual({name: "Franz", age: 45, sub: {}});

            expect(await apiProxy.returnAny()).toStrictEqual({extra: true});
            expect(await apiProxy.returnUnknown()).toStrictEqual({extra: true});

        }
    );
})

it('should trim result but not modify the original objects', async () => {


    const myObj: {a: boolean} = {a:true, extra: "something"} as any
    class ServerAPI extends ServerSession {
        @remote()
        getMyObjTrimmed() {
            return myObj
        }

        @remote({trimResult: false, validateResult: false})
        getOriginalMyObj() {
            return myObj
        }
    }

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expect(await apiProxy.getOriginalMyObj()).toStrictEqual({a:true, extra: "something"})
            expect(await apiProxy.getMyObjTrimmed()).toStrictEqual({a:true})
            expect(await apiProxy.getOriginalMyObj()).toStrictEqual({a:true, extra: "something"}) // Should still have the extra property

        }
    );
})

test('Test BigInt', async () => {

    class A {
        i: BigInt
    }

    const iProp = reflect(A).getProperty("i");
    expect(iProp.matchesValue(123n)).toBe(true);
    expect(iProp.matchesValue(undefined)).toBe(false);
    expect(iProp.matchesValue(null)).toBe(false);
    expect(iProp.matchesValue(123)).toBe(false);
    expect(iProp.matchesValue("")).toBe(false);
    expect(iProp.matchesValue(-1)).toBe(false);
    expect(iProp.matchesValue(Number.NaN)).toBe(false);
    expect(iProp.matchesValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(iProp.matchesValue(Number.NEGATIVE_INFINITY)).toBe(false);
})

/**
 * See https://github.com/typescript-rtti/typescript-rtti/issues/92
 */
test('Test additional properties / overstrict checks', async () => {
    class ServerAPI extends TypecheckingService {
        @remote({trimArguments: false})
        setObjWithValues(z: {prop1: boolean}) {
        }

    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: true, poisonedProp: true}), INVALID_ARGUMENTS_MESSAGE );
        }
    );
})


test('Test rest arguments', async () => {
    class ServerAPI extends TypecheckingService {
        @remote()
        restParams(x: string, ...y: number[]) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x");
            await apiProxy.restParams("x", 1,2,3);

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, {}), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, undefined), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,undefined,3), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []), INVALID_ARGUMENTS_MESSAGE );

            const variousInvalidRestParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidRestParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p), INVALID_ARGUMENTS_MESSAGE );
            }

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []), INVALID_ARGUMENTS_MESSAGE );

        }
    );
})

/**
 * See https://github.com/typescript-rtti/typescript-rtti/issues/92
 */
test('Test result validation', async () => {
    class ServerAPI extends TypecheckingService {

        @remote()
        returnsString(value: any): string {
            return value
        }

        @remote()
        async returnsStringViaPromise(value: any): Promise<string> {
            return value
        }

        @remote()
        returnsStringImplicitly(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        async returnsStringImplicitlyViaPromise(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        voidMethodReturnsIllegalValue(): void {
            // @ts-ignore
            return "test";
        }

        @remote({validateResult: false})
        returnsIllegalValuesVithoutValidation():string {
            // @ts-ignore
            return {}
        }

        @remote()
        returnsOptionalString(value: any): string | undefined {
            return value;
        }

        @remote()
        returnsImplicitOptionalString(value: string | undefined) {
            return value;
        }

        @remote()
        returnsObject(value: any): {z: string} {
            return value
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            const variousValues = ["", true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(const value of variousValues) {
                if(typeof value === "string") {
                    await apiProxy.returnsString(value)
                    await apiProxy.returnsStringViaPromise(value)
                    await apiProxy.returnsStringImplicitly(value)
                    await apiProxy.returnsStringImplicitlyViaPromise(value)
                }
                else {
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringViaPromise(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitly(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitlyViaPromise(value), INVALID_RETURN_MESSAGE);
                }
            }

            expect(await apiProxy.returnsOptionalString(undefined)).toBe(undefined);

            await expectAsyncFunctionToThrow(async () => await apiProxy.voidMethodReturnsIllegalValue(), INVALID_RETURN_MESSAGE);
            await apiProxy.returnsIllegalValuesVithoutValidation();

            await expectAsyncFunctionToThrow(async () => await apiProxy.returnsObject({z: 123}), /invalid.*\.z/); // .z should be contained in the message
            await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(123), /invalid.*123/); // .z should be contained in the message
        }
    );
})

test('Test result validation with null and undefined', async () => {
    class ServerAPI extends TypecheckingService {
        @remote()
        returnsString(value: any): string {
            return value
        }

        @remote()
        async returnsStringViaPromise(value: any): Promise<string> {
            return value
        }

        @remote()
        returnsStringImplicitly(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        async returnsStringImplicitlyViaPromise(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        voidMethodReturnsIllegalValue(): void {
            // @ts-ignore
            return "test";
        }

        @remote({validateResult: false})
        returnsIllegalValuesVithoutValidation():string {
            // @ts-ignore
            return {}
        }

        @remote()
        returnsOptionalString(value: any): string | undefined {
            return value;
        }

        @remote()
        returnsImplicitOptionalString(value: string | undefined) {
            return value;
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            const variousValues = [null, undefined]
            for(const value of variousValues) {
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringViaPromise(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitly(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitlyViaPromise(value), INVALID_RETURN_MESSAGE);
            }

            expect(await apiProxy.returnsOptionalString(undefined)).toBe(undefined);

            await expectAsyncFunctionToThrow(async () => await apiProxy.voidMethodReturnsIllegalValue(), INVALID_RETURN_MESSAGE);
            await apiProxy.returnsIllegalValuesVithoutValidation();

        }
    );
})

describe("callbacks", () => {
    class ServerAPI extends TypecheckingService {
        @remote()
        async callVoidPromiseCallback(callback: ()=> Promise<void>) {
            await callback();
        }

        @remote()
        async callStringPromiseCallback(callback: ()=> Promise<string>) {
            return await callback();
        }

        @remote()
        async putArgsIntoCallback(callback: (a: string, b: number, c?: {myFlag: boolean})=> Promise<any>, args:any[], options: Partial<ClientCallbackOptions>) {
            (callback as ClientCallback).options = {...(callback as ClientCallback).options, ...options}; // add options
            return await callback.call(undefined,...args);
        }

        @remote()
        async callObjectPromiseCallback(callback: ()=> Promise<{a: string, b?:number }>, options: Partial<ClientCallbackOptions>) {
            (callback as ClientCallback).options = {...(callback as ClientCallback).options, ...options}; // Add options
            return await callback();
        }


    }

    it("should allow legal args in a simple callback", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();

        await expect(async () => apiProxy.putArgsIntoCallback(mock, ["abc", 3, {myFlag: true}],{})).resolves.toReturn()

    }, {
        useSocket: true
    }));

    it("should error when putting illegal args into a simple callback", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();

        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, [],{}), /invalid number of arguments/)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, [1,2,3],{}), /invalid number of arguments/)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, [123,3],{}), /expected.*string.*123/)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, ["abc","x"],{}), /expected.*number.*x/)

    }, {
        useSocket: true
    }));

    it("should trim extra properties", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        async function returnExact(...args:any[]) { return args}

        expect(await apiProxy.putArgsIntoCallback(returnExact, ["abc", 3, {myFlag: true, extraProperty: true}],{})).toStrictEqual(["abc", 3, {myFlag: true}])

    }, {
        useSocket: true
    }));

    it("should fail with extra properties when trimArguments is disabled", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        async function returnExact(...args:any[]) { return args}

        expectAsyncFunctionToThrow(() => apiProxy.putArgsIntoCallback(returnExact, ["abc", 3, {myFlag: true, extraProperty: true}],{trimArguments: false}), /extraProperty/)

    }, {
        useSocket: true
    }));




    it("should error when a callback with Promise<void> returns non-void", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();
        await apiProxy.callVoidPromiseCallback(async () => {});
        // @ts-ignore
        await expectAsyncFunctionToThrow(async () => apiProxy.callVoidPromiseCallback(async () => {return "aString"}), /aString/)

    }, {
        useSocket: true
    }));

    it("should error when a callback with Promise<string> returns number", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();
        await apiProxy.callVoidPromiseCallback(async () => {});
        // @ts-ignore
        await expectAsyncFunctionToThrow(async () => apiProxy.callStringPromiseCallback(async () => {return 123}), /expected.*string.*123/i)

    }, {
        useSocket: true
    }));

    it("should trim extra properties off the result", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        expect(await apiProxy.callObjectPromiseCallback(async () => {return {a: "123", b: 4, extraProp: true}}, {} )).toStrictEqual({a: "123", b: 4})
    }, {
        useSocket: true
    }));

    it("should fail with extra properties when trimArguments is disabled", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await expectAsyncFunctionToThrow(() => apiProxy.callObjectPromiseCallback(async () => {return {a: "123", b: 4, extraProp: true}} ,{trimResult: false}), /extraProp/ );

    }, {
        useSocket: true
    }));
})

/*
// Not yet implemented
test('Test destructuring arguments', async () => {
    class ServerAPI {
        restParams(x: string, {a: boolean, b: string}) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x", {a: true, b: "test"});

            const variousInvalidParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p) );
            }

        }
    );

});
*/

/*
// Anonymous classes can't have @remote decorators, so its meaningless to test them
test('Test with anonymous class', async () => {

    await runClientServerTests(new class extends TypecheckingService{
            params1(x: string) {
            }
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})
*/

/*
// This one fails with current typescript-rtti. But that's not a showstopper.
test('Test anonymous object as service', async () => {
    await runClientServerTests({
            myVoidMethod() {
            },
            params1(x: string) {
            },
            params2(x: string, y: number, z: {}) {
            },
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})
*/