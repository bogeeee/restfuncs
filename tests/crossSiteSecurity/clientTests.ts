import {RestfuncsClient, restfuncsClient} from "restfuncs-client"
import {StatelessService} from "./StatelessService";
import {MainframeService} from "./MainframeService";

export const mainSitePort = 3000;
export const isMainSite = Number(window.location.port) === mainSitePort;
let failed = false;

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

async function assertWorksXS(description: string, fn: () => Promise<void>) {
    console.log(description + "...");
    try {
        await assertRuns(fn);
        console.log(`...expectedly runs ${isMainSite?"": "cross site "}`)
    }
    catch (e) {
        failed = true;
        console.log(`!!!...unexpectedly failed ${isMainSite?"": "cross site "}`)
        console.error(e);
    }

}

/**
 * Assert that it should work on the main site but fail cross-site
 * @param description
 * @param fn
 */
async function assertFailsXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    if(isMainSite) {
        try {
            await assertRuns(fn);
            console.log(`...expectedly runs on main site`)
        }
        catch (e) {
            failed = true;
            console.log(`!!!...failed on main site`)
            console.error(e);
        }
    }
    else {
        try {
            await assertFails(fn);
            console.log(`...expectedly fails cross site`)
        }
        catch (e) {
            failed = true;
            console.log(`!!!...runs cross site but was expected to fail`)
        }
    }

}


export async function runAlltests() {
    failed = false;

    const statelessService = new RestfuncsClient<StatelessService>( `http://localhost:${mainSitePort}/statelessService`).proxy
    const allowedStatelessService = new RestfuncsClient<StatelessService>( `http://localhost:${mainSitePort}/allowedStatelessService`).proxy


    await assertFailsXS("call test() on normal service", async () => {
        if(await statelessService.test() !== "ok") {
            throw "...";
        }
    });

    await assertWorksXS("call test() on allowed service", async () => {
        if(await allowedStatelessService.test() !== "ok") {
            throw "..."
        }
    });


    await assertFailsXS("call GET method on normal service", async () => {
        if(await statelessService.getTest() !== "ok") {
            throw "unexpected result";
        }
    });

    return !failed;
}