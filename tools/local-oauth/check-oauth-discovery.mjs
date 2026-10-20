import {inspectDiscovery} from './discovery.mjs';

const result = await inspectDiscovery();
console.log(JSON.stringify(result, null, 2));
if (result.result !== 'metadata_verified') process.exitCode = 2;
