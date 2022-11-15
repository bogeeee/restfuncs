import {restClient} from "@restfuncs/client"
import {GreeterService} from "../server/GreeterService.js"; // Import to have types

const greeterService = restClient<GreeterService>("http:/localhost:3000/greeterAPI")
document.getElementById("view")!.textContent = await greeterService.greet("Bob");