import {RestfuncsClient} from "restfuncs-client"
import {MainframeSession} from "../MainframeSession.js" // Import to have types
import {IServerSession} from "restfuncs-common";


let useSocket = window.location.href.toString().indexOf("socket") > -1;
const mainframeService = new RestfuncsClient<MainframeSession>("/mainframeAPI", {useSocket}).proxy // This is the way to use a subclassed RestfuncsClient

// Click handler for multiply button:
document.getElementById("setValueButton").onclick = async function() {
    // @ts-ignore
    const inputValue = document.getElementById("valueInput").value
    const result = await mainframeService.setValue(inputValue);
}

setInterval(async () => {
    let value = await mainframeService.getValue();
    document.getElementById("polledValue").textContent = `Polled value = ${value}\npolled via ${useSocket?"socket":"http (add 'socket' to the url to use sockets)"}`
}, 1000);