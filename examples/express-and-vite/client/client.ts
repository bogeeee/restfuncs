import {RestfuncsClient} from "restfuncs-client";
import {GreeterSession} from "../GreeterSession.js" // Import to have types

(async () => {
    const greeterSession = new RestfuncsClient<GreeterSession>("/greeterAPI", {/* options */}).proxy
    document.getElementById("main")!.textContent = await greeterSession.greet("Bob")
})()