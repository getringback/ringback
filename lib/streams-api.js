"use strict";
// Phone routes for live terminals and machine screens (spec 04 section 6). Long-polls carry
// their own wait so the client's idle bound (wait + grace) never cuts them; no AI call here.

const { request } = require("./client.js");

const id = (v) => encodeURIComponent(v);
const RECORD_STOP_WAIT_S = 60;

const streamsApi = {
  putCaps: (cfg, caps) => request(cfg, "PUT", "/v1/streams/caps", caps),
  pollRequests: (cfg, machine, since, waitS = 50) =>
    request(cfg, "GET", `/v1/streams/requests?machine=${id(machine)}&wait_s=${waitS}${since ? `&since=${id(since)}` : ""}`, undefined, { waitS }),
  create: (cfg, body) => request(cfg, "POST", "/v1/streams", body),
  get: (cfg, sid, version = 0, waitS = 60) =>
    request(cfg, "GET", `/v1/streams/${id(sid)}?version=${Number(version) || 0}&wait_s=${waitS}`, undefined, { waitS }),
  end: (cfg, sid) => request(cfg, "DELETE", `/v1/streams/${id(sid)}`),
  record: (cfg, sid, body) => request(cfg, "POST", `/v1/streams/${id(sid)}/record`, body, { waitS: RECORD_STOP_WAIT_S }),
  list: (cfg) => request(cfg, "GET", "/v1/streams"),
};

module.exports = { streamsApi };
