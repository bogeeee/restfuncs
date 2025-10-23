import {ClientSocketConnection, RestfuncsClient} from "restfuncs-client"
import {MainframeSession} from "../MainframeSession.js" // Import to have types
import {IServerSession} from "restfuncs-common";

import {ExternalPromise} from 'restfuncs-common'; ExternalPromise.diagnosis_recordCallstacks=true;

let client = new RestfuncsClient<MainframeSession>("/mainframeAPI", {});


const mainframeService = client.proxy

const hook =  {}

// set value button:
document.getElementById("pingButton")!.onclick = async function() {
    await client.proxy.ping();
}

client.withReconnect((isReconnect) => {
    console.log(`Running fn. isReconnect = ${isReconnect}`);
    mainframeService.ping();
}, hook)