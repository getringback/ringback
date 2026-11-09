"use strict";
// search_calls (FOLLOWUPS item 30): recall what was said on earlier calls. Transcripts stay on the
// phone; the phone answers with the matching lines of calls this computer took part in (all calls
// only when the user turned on "let my agents search all my calls" in the app).

const { api } = require("../client.js");

const tools = [
  {
    name: "search_calls",
    description:
      "Search earlier Ringback calls with the user (their transcripts live on the phone). Every word of `query` must appear. " +
      "Returns matching calls with the lines that matched; read a whole call with its call_id if needed. " +
      "Use it to recall what the user said on a call, e.g. what they decided yesterday.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find, e.g. 'deploy friday'." },
        since: { type: "string", description: "Only calls from this date on (YYYY-MM-DD or an ISO time)." },
        until: { type: "string", description: "Only calls up to this date (YYYY-MM-DD or an ISO time)." },
        session: { type: "string", description: "Only calls with this session id." },
        limit: { type: "number", description: "At most this many calls (default 20, max 50)." },
      },
      required: ["query"],
    },
  },
];

const handlers = () => ({
  search_calls: (cfg, a) => api.searchCalls(cfg, a),
});

module.exports = { tools, handlers };
