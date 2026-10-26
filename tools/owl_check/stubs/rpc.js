export async function rpc(url) { return globalThis.__rpcStub ? globalThis.__rpcStub(url) : "pk.fake"; }
