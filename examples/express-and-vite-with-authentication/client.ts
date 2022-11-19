import {restClient} from "@restfuncs/client"
import {CounterService} from "./CounterService" // Import to have types

const counterService = restClient<CounterService>("/counterAPI")

async function updateCounter() {
    document.getElementById("counter")!.textContent = "" + await counterService.getCounter()
}
updateCounter();

// Count button:
document.getElementById("countButton").onclick = async () => {
    await counterService.count();
    updateCounter();
}

