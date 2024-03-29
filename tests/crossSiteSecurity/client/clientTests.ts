import {develop_resetGlobalState, RestfuncsClient} from "restfuncs-client"
import {TestsService} from "../TestsService";
import {MainframeService} from "../MainframeService";
import {ControlService} from "../ControlService";
import {ClientSocketConnection} from "restfuncs-client";

export const mainSiteUrl = "http://localhost:3000";
export const isMainSite = window.location.href.startsWith(mainSiteUrl);
let failed = false;
const debug_failAllTestsOnFirstFail = false; // enable to have a better error stack trace in the console (use firefox instead of chrome then)

async function assertRuns(fn: () => Promise<void>) {
    await fn();
}

async function assertFails(fn: () => Promise<void>) {
    try {
        await fn();
        throw new Error("Expected to fail");
    }
    catch (e) {
        // ok
    }
}


function failTests(e: unknown) {
    failed = true;
    if(e) {
        if (debug_failAllTestsOnFirstFail) {
            throw e;
        }
        console.error(e);
    }
}

/**
 * Assert that it should fail same-site and also cross site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertFailsSSAndXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    try {
        await assertFails(fn);
        console.log(`...expectedly fails`)
    }
    catch (e) {
        console.log(`...!!! runs but was expected to fail`)
        failTests(null);
    }

}

/**
 * Assert that it should work same-site and also cross site
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndXS(description: string, fn: () => Promise<void>) {
    console.log(description + "...");
    try {
        await assertRuns(fn);
        console.log(`...expectedly runs ${isMainSite?"": "cross site "}`)
    }
    catch (e) {
        console.log(`...!!! unexpectedly failed ${isMainSite?"": "cross site"}. See the following error:`)
        failTests(e)
    }

}

/**
 * Assert that it should work same-site but fail cross-site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndFailsXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    if(isMainSite) {
        try {
            await assertRuns(fn);
            console.log(`...expectedly runs on main site`)
        }
        catch (e) {
            console.log(`...!!! failed on main site. See the following error:`)
            failTests(e);
        }
    }
    else {
        try {
            await assertFails(fn);
            console.log(`...expectedly fails cross site`)
        }
        catch (e) {
            console.log(`...!!! runs cross site but was expected to fail`)
            failTests(null);
        }
    }

}

function assertEquals<T>(actual: T, expected: T) {
    if(actual !== expected) {
        throw new Error(`Assertion failed: actual: ${actual}, expected: ${expected}`);
    }
}

function awaitBeacon() {
    return new Promise((resolve, reject) => {setTimeout(resolve, 250)});
}

function makeSimpleXhrRequest(method: string, url: string, body = ""): Promise<string> {


    return new Promise((resolve, reject)=> {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.withCredentials = true;
            xhr.onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
                if (this.readyState == 4) {
                    if(this.status === 200) {
                        resolve("")
                    }
                    else {
                        reject(this.responseText)
                    }
                }
            };
            xhr.send(body);
        }
        catch (e) {
            reject(e);
        }
    })



}

const controlService = new RestfuncsClient<ControlService>(`${mainSiteUrl}/ControlService`, {useSocket: false}).proxy

async function resetGlobalState() {
    await controlService.resetSession();
    develop_resetGlobalState()
}

async function createRestfuncsClient(serviceName: string, csrfProtectionMode: string, options: Partial<RestfuncsClient<any>>) {
    // @ts-ignore
    const result = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {csrfProtectionMode, ...options});
    if(csrfProtectionMode === "csrfToken") {
        // Fetch the token first:
        result.csrfToken = await controlService.getCsrfTokenForService(serviceName)
    }
    return result;
}

/**
 * Test CORS and simple requests. All with "preflight" security:
 */
async function testSuite_CORSAndSimpleRequests(useSocket: boolean) {
    {
        await resetGlobalState();

        const service = new RestfuncsClient<TestsService>(`${mainSiteUrl}/TestsService`, {csrfProtectionMode: "preflight", useSocket}).proxy
        const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: "preflight", useSocket}).proxy

        /**
         * tests if runner successfully was able to spend money on bob's cookie-logged-in session.
         * @param runner
         */
        async function checkIfSpendsMoney(runner: () => Promise<void>) {
            await corsAllowedService.logon("bob"); // Logs in and give me some money
            assertEquals(await corsAllowedService.getBalance("bob"), 5000)
            let caught: any;
            try {
                await runner()
            } catch (e) {
                caught = e;
            }
            if (await corsAllowedService.getBalance("bob") !== 0) {
                throw new Error(`Money was not spent: ${caught?.message || caught || ""}`, {cause: caught});
            }
        }

        await testAssertWorksSSAndFailsXS("call test() on restricted service", async () => {
            assertEquals(await service.test(), "ok")
        });

        await testAssertWorksSSAndXS("call test() on allowed service", async () => {
            assertEquals(await corsAllowedService.test(), "ok")
        });

        // Simple requests:
        for (const method of ["GET", "POST"]) {
            await testAssertFailsSSAndXS(`Simple request on unsafe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/unsafeMethod`)
            }));

            await testAssertWorksSSAndXS(`Simple request on safe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/spendMoneyAccidentlyMarkedAsSafe`)
            }));
        }


        await testAssertWorksSSAndFailsXS("Spend money on restricted service", async () => checkIfSpendsMoney(async () => {
            await service.spendMoney();
        }));

        await testAssertWorksSSAndXS("Spend money on allowed service", async () => checkIfSpendsMoney(async () => {
            await corsAllowedService.spendMoney();
        }));


        // Test if we can spend money throug simple request (if they might get called but result can't be read)
        for (const method of ["GET", "POST"]) {
            // Test/Playground to see if makeSimpleXhrRequest really does make simple requests and if it's property detected. No real security indication
            await testAssertWorksSSAndFailsXS(`Simple request (${method})`, async () => {
                await controlService.clearLastCallWasSimpleRequest()
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/getIsSimpleRequest`)
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });
            await testAssertWorksSSAndXS(`Simple request (${method})`, async () => {
                await controlService.clearLastCallWasSimpleRequest()
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/getIsSimpleRequest`, "xyz")
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });

            //
            await testAssertWorksSSAndFailsXS(`Spend money on restricted service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/spendMoney`)
            }));

            await testAssertWorksSSAndXS(`Spend money on allowed service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/spendMoney`) // should work because we look at the origin header
            }));

            await testAssertFailsSSAndXS(`Spend money on restricted service with simple request (${method}) with eraseOrigin`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService_eraseOrigin/spendMoney`) // simple requests no non-safe methods should be blocked
            }));
        }
    }
}

async function testSuite_Beacons() {

    await resetGlobalState();

    const service = new RestfuncsClient<TestsService>(`${mainSiteUrl}/TestsService`, {
        csrfProtectionMode: "preflight",
        useSocket: false
    }).proxy
    const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {
        csrfProtectionMode: "preflight",
        useSocket: false
    }).proxy

    /**
     * tests if runner successfully was able to spend money on bob's cookie-logged-in session.
     * @param runner
     */
    async function checkIfSpendsMoney(runner: () => Promise<void>) {
        await corsAllowedService.logon("bob"); // Logs in and give me some money
        assertEquals(await corsAllowedService.getBalance("bob"), 5000)
        let caught: any;
        try {
            await runner()
        } catch (e) {
            caught = e;
        }
        if (await corsAllowedService.getBalance("bob") !== 0) {
            throw new Error(`Money was not spent: ${caught?.message || caught || ""}`, {cause: caught});
        }
    }

    // Detect, which types of sendBeacon are treated as simple requests
    const jsonInArrayBuffer: ArrayBuffer = new TextEncoder().encode('{"myArg": "string"}');
    const jsonBlob = new Blob([JSON.stringify({myArg: "world"}, null, 2)], {
        type: "application/json",
    });
    const textBlob = new Blob([JSON.stringify("myArg", null, 2)], {
        type: "text/plain",
    });
    const types: {name: string, value?: BodyInit, isSimpleRequest?: boolean}[] = [
        {name: "undefined", value: undefined},  // on chrome, it sends no content-type and therefore it should be detected simple request
        {name: "string", value: "someString"},
        {name: "jsonInArrayBuffer", value: jsonInArrayBuffer},
        {name: "jsonBlob", value: jsonBlob}, // Will be a non simple request
        {name: "textBlob", value: textBlob},
    ];

    for (const iter of types) {
        await testAssertWorksSSAndXS(`sendBeacon -> allowed service: ${iter.name}`, async () => {
            await controlService.clearLastCallWasSimpleRequest()
            navigator.sendBeacon(`${mainSiteUrl}/AllowedTestsService/testBeacon`, iter.value)
            await awaitBeacon();
            iter.isSimpleRequest = await corsAllowedService.getLastCallWasSimpleRequest();
            if(iter.isSimpleRequest === undefined) {
                throw new Error("Could not determine isSimpleRequest");
            }
        });

        await testAssertWorksSSAndFailsXS(`sendBeacon: ${iter.name}`, async () => { // should fail XS, because the proper origin header is sent
            await controlService.clearLastCallWasSimpleRequest()
            navigator.sendBeacon(`${mainSiteUrl}/TestsService/testBeacon`, iter.value);
            await awaitBeacon();
            assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), iter.isSimpleRequest)
        });
    }


    for (const iter of types) {
        if(iter.isSimpleRequest === true) {
            continue; //
        }
        for (const eraseOrigin of [false, true]) {
            // With erase origin, we only rely on the proper browser's preflight. Here we test, if the browser does this properly
            // TODO: This may not work with a JWT session handler, since the cookie might not be returned back by the beacon -> test, how it behaves
            await testAssertWorksSSAndFailsXS(`sendBeacon ->  Spend money on restricted service ${eraseOrigin ? "with erased origin" : ""} with type: ${iter.name}`, async () => checkIfSpendsMoney(async () => {
                navigator.sendBeacon(`${mainSiteUrl}/TestsService${eraseOrigin ? "_eraseOrigin" : ""}/spendMoney`, iter.value)
                await awaitBeacon();
            }));

            // TODO: This may not work with a JWT session handler, since the cookie might not be returned back by the beacon -> test, how it behaves
            await testAssertWorksSSAndXS(`sendBeacon ->  Spend money on allowed service ${eraseOrigin ? "with erased origin" : ""} with type: ${iter.name}`, async () => checkIfSpendsMoney(async () => {
                navigator.sendBeacon(`${mainSiteUrl}/AllowedTestsService${eraseOrigin ? "_eraseOrigin" : ""}/spendMoney`, iter.value)
                await awaitBeacon();
            }));
        }
    }

}

/**
 * Copying corsReadToken from an allowed service to a restricted service, ...
 */
async function testSuite_copyCorsReadToken() {
    if (isMainSite) {
        // isMainSite: AllowedTestsService_eraseOrigin doesn't work cross origin. We would need to mock it somehow that in the normal response the access-control-allow-origin header is filled with i.e localhost:3666.
        // Sencondly: The TestsService is blocked by browser's CORS anyway

        await testAssertWorksSSAndXS(`Copying corsReadToken from an allowed service to a restricted service should not work. Copying the proper one to the resrticted service should work`, async () => {
            await resetGlobalState();

            // @ts-ignore
            const allowedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService_eraseOrigin`, {csrfProtectionMode: "corsReadToken", useSocket: false});
            const allowedService = allowedClient.proxy
            await allowedService.logon("bob");

            const restrictedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/TestsService`, {csrfProtectionMode: "corsReadToken", useSocket: false});
            const restrictedService = restrictedClient.proxy;
            const loginOnRestrictedService = async () => {
                await restrictedService.logon("bob");
            }

            if (isMainSite) {
                await loginOnRestrictedService();
            } else {
                await assertFails(loginOnRestrictedService)
            }

            // @ts-ignore
            if (!allowedClient._corsReadToken) {
                throw new Error("_corsReadToken was not yet fetched")
            }

            // Copy the one from allowed service:
            // @ts-ignore
            restrictedClient._corsReadToken = allowedClient._corsReadToken

            // Should still fail:
            if (isMainSite) {
                await loginOnRestrictedService();
            } else {
                await assertFails(loginOnRestrictedService)
            }

            // Obtain a valid one by cheating:
            // @ts-ignore
            restrictedClient._corsReadToken = await controlService.getCorsReadTokenForService("TestsService")
            await loginOnRestrictedService(); // now this should work
            assertEquals(await restrictedService.getBalance("bob"), 5000);
        });
    }
}

async function testSuite_csrfToken(useSocket: boolean) {
    // CSRFToken:
    for (const serviceName of ["TestsService", "AllowedTestsService"]) {
        if (serviceName === "TestsService" && !isMainSite) {
            continue; // TestsService is blocked anyway by browser's CORS
        }
        await testAssertWorksSSAndXS(`Check if no/wrong csrfToken is rejected and proper token is accepted for ${serviceName}`, async () => {
            await resetGlobalState();
            // No token:
            {
                const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {
                    csrfProtectionMode: "csrfToken",
                    useSocket
                });
                // no token:
                await assertFails(async () => {
                    await client.proxy.logon("bob")
                })
                await client.close();
            }

            // wrong token:
            {
                const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {
                    csrfProtectionMode: "csrfToken",
                    useSocket
                });
                client.csrfToken = "wrongValue"
                await assertFails(async () => {
                    await client.proxy.logon("bob")
                })
                await client.close();
            }

            // right token:
            {
                const conns = (await ClientSocketConnection.getAllOpenSharedConnections())
                const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {
                    csrfProtectionMode: "csrfToken",
                    useSocket
                });
                client.csrfToken = await controlService.getCsrfTokenForService(serviceName);
                await client.proxy.logon("bob");
                assertEquals(await client.proxy.getBalance("bob"), 5000);
                await client.close();
            }

            // right token but from wrong service:
            {
                const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {
                    csrfProtectionMode: "csrfToken",
                    useSocket
                });
                client.csrfToken = await controlService.getCsrfTokenForService("MainframeService");
                await assertFails(async () => {
                    await client.proxy.logon("bob")
                });
                await client.close();
            }
        });
    }
}

async function testSuite_csrfProtectionModesCollision(useSocket: boolean) {
    // Test the "collision" of different csrfProtection modes:
    {
        for (const mode1 of ["preflight", "corsReadToken", "csrfToken"]) {
            for (const mode2 of ["preflight", "corsReadToken", "csrfToken"]) {
                if (mode1 == mode2) {
                    await testAssertWorksSSAndXS(`Requests from same session protection modes with forceTokenCheck, (${mode1} )`, async () => {
                        await resetGlobalState();

                        for (const mode of [mode1, mode2]) {
                            const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode, {useSocket})).proxy
                            await corsAllowedService.test();
                        }
                    });
                    await testAssertWorksSSAndXS(`Requests from same session protection modes with session access, (${mode1} )`, async () => {
                        await resetGlobalState();


                        const corsAllowedService1 = (await createRestfuncsClient("AllowedTestsService", mode1,{useSocket})).proxy
                        await corsAllowedService1.logon("bob");

                        const corsAllowedService2 = (await createRestfuncsClient("AllowedTestsService", mode2, {useSocket})).proxy
                        assertEquals(await corsAllowedService2.getBalance("bob"), 5000);
                    });

                } else {
                    for (const method of ["GET", "POST"]) {
                        await testAssertWorksSSAndXS(`Requests from different session protection modes but without session access, (simple ${method} ${mode1} vs restfuncs-client ${mode2} )`, async () => {
                            await resetGlobalState();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/test?csrfProtectionMode=${mode1}`)

                            const corsAllowedService = (await createRestfuncsClient("AllowedTestsService", mode2, {useSocket})).proxy
                            await corsAllowedService.test();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/test`) // unspecified
                        });
                    }


                    await testAssertWorksSSAndXS(`Requests from different session protection modes with forceTokenCheck, (${mode1} vs ${mode2} )`, async () => {
                        await resetGlobalState();

                        {
                            const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode1, {useSocket})).proxy
                            await corsAllowedService.test();
                        }
                        {
                            await assertFails(async () => {
                                const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode2, {useSocket})).proxy
                                await corsAllowedService.test();
                            })
                        }

                    });

                    await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (${mode1} vs ${mode2} )`, async () => {
                        await resetGlobalState();


                        const service1 = (await createRestfuncsClient("AllowedTestsService", mode1, {useSocket})).proxy
                        await service1.logon("bob");

                        await assertFails(async () => {
                            const service2 = (await createRestfuncsClient("AllowedTestsService", mode2,{useSocket})).proxy
                            await service2.getBalance("bob")
                        });
                    });


                }

            }
        }

        // Test that undefined initializes the session as preflight
        await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (undefined = preflight vs corsReadToken )`, async () => {
            await resetGlobalState();

            // @ts-ignore
            const corsAllowedService1 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: undefined, useSocket}).proxy
            await corsAllowedService1.logon("bob");

            // @ts-ignore
            const corsAllowedService2 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: "corsReadToken", useSocket}).proxy
            await assertFails(async () => {
                await corsAllowedService2.getBalance("bob")
            });
        });

    }
}

export async function runAlltests() {
    failed = false;

    console.log("Waiting for lock...")
    await controlService.getLock() // Prevent it from running in 2 browser windows at the same time
    console.log("got lock");
    try {

        await testSuite_Beacons();

        for (const useSocket of [false, true]) {
            console.log(`**********************************************************`)
            console.log(`**** Following tests are with useSocket=${useSocket} *****`)
            console.log(`**********************************************************`)

            await testSuite_CORSAndSimpleRequests(useSocket);

            if (!useSocket) {
                await testSuite_copyCorsReadToken();
            }

            await testSuite_csrfToken(useSocket);

            await testSuite_csrfProtectionModesCollision(useSocket);
        }
        return !failed;
    }
    finally {
        await controlService.releaseLock()
    }
}