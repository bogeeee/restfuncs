import 'reflect-metadata'
import {ServerSession as ServerSession} from "restfuncs-server/ServerSession";
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

test('Test arguments - extra properties value / shape arguments', async () => {

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

test('shape result', async () => {

    type IUser=  {
        name: string,
        age: number,
        password: string,
        sub?: {
            subExtra: string
        }
    }

    class ServerAPI extends ServerSession {

        @remote({shapeResult: false})
        doesntShapeResult(): {} {
            return {extra: true}
        }

        @remote()
        shapeResult(): {} {
            return {extra: true}
        }

        @remote()
        async shapeResultAsync(): Promise<{}> {
            return {extra: true}
        }

        @remote()
        shapeResultImplicit() {
            return {extra: true} as {}
        }

        @remote()
        shapeResultWithPick(): Pick<IUser, "name" | "age"> { // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        shapeResultWithOmit(): Omit<IUser, "password">{  // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        shapeResultWithOmitWithSub(): Omit<IUser, "password" | "sub"> & {sub: Omit<IUser["sub"], "extra">} {
            const user = {name: "Franz", age: 45, password: "geheim!", sub: {subExtra: "extra"}}
            return user;
        }


    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expectAsyncFunctionToThrow(apiProxy.doesntShapeResult, /invalid.*extra/);
            expect(await apiProxy.shapeResult()).toStrictEqual({});
            expect(await apiProxy.shapeResultAsync()).toStrictEqual({});
            expect(await apiProxy.shapeResultImplicit()).toStrictEqual({});
            expect(await apiProxy.shapeResultWithPick()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.shapeResultWithOmit()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.shapeResultWithOmitWithSub()).toStrictEqual({name: "Franz", age: 45, sub: {}});

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