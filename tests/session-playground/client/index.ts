import {RestfuncsClient} from "restfuncs-client"
import {MainframeSession} from "../MainframeSession.js" // Import to have types
import {IServerSession} from "restfuncs-common";


let useSocket = window.location.href.toString().indexOf("socket") > -1;
const mainframeService = new RestfuncsClient<MainframeSession>("/mainframeAPI", {useSocket}).proxy

// set value button:
document.getElementById("setValueButton")!.onclick = async function() {
    // @ts-ignore
    const inputValue = document.getElementById("valueInput").value
    const result = await mainframeService.setValue(inputValue);
}

// Set value via other button:
const otherClient  = new RestfuncsClient<MainframeSession>("/mainframeAPI", {useSocket: !useSocket}).proxy
let viaOtherButton = document.getElementById("setValueViaOtherButton");
viaOtherButton!.onclick = async function() {
    // @ts-ignore
    const inputValue = document.getElementById("valueInput").value
    const result = await otherClient.setValue(inputValue);
}
viaOtherButton!.textContent = "Set value via other (" + (useSocket?"http":"socket") + ")";

// Destroy button:
document.getElementById("destroyButton")!.onclick = async function() {
    await mainframeService.destroy()
}



// Poll regularly:
setInterval(async () => {
    let value = await mainframeService.getValue();
    document.getElementById("polledValue")!.textContent = `Polled value = ${value}\npolled via ${useSocket?"socket":"http (add 'socket' to the url to use sockets)"}`
}, 1000);
