const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

/** Read every available descendant page, and say when the party is incomplete. */
export async function readDescendants(threadId, request, readThread) {
  const ids = new Set();
  const warnings = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    let result;
    try {
      result = await request("thread/list", {
        ancestorThreadId: threadId, sourceKinds: SOURCE_KINDS,
        limit: 100, sortKey: "updated_at", ...(cursor ? { cursor } : {}),
      });
    } catch {
      warnings.push("Some party members could not be listed.");
      break;
    }
    for (const item of result.data || []) {
      if (item?.id && item.id !== threadId) ids.add(item.id);
    }
    if (!result.nextCursor) break;
    if (result.nextCursor === cursor || page === 19) {
      warnings.push("This party has more members than Goblin Horde could load.");
      break;
    }
    cursor = result.nextCursor;
  }

  const agents = [];
  const members = [...ids];
  for (let offset = 0; offset < members.length; offset += 8) {
    const settled = await Promise.allSettled(members.slice(offset, offset + 8).map(readThread));
    for (const item of settled) {
      if (item.status === "fulfilled") agents.push(item.value);
      else if (!warnings.includes("Some party members could not be read."))
        warnings.push("Some party members could not be read.");
    }
  }
  return { agents, warning: warnings.join(" ") };
}
