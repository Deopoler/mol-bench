import { createOrreryBench } from "./orrery.js";

const stageEl = document.getElementById("orrery-stage") || document.body;
const bench = createOrreryBench(stageEl);
window.__bench = bench;
