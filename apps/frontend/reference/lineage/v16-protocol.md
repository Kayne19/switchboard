# Switchboard Controller Protocol v1

Damocles gets six operations. It never sends coordinates, CSS, breakpoints, or layout names.

```json
{"op":"show","id":"loss","type":"chart","role":"primary","data":{}}
{"op":"hide","id":"loss"}
{"op":"say","text":"Validation begins diverging here.","target":"loss"}
{"op":"focus","id":"loss"}
{"op":"listen","on":true}
{"op":"clear"}
```

`show` is an upsert. Reusing an `id` updates that object. `role` is optional. Use `primary` for the thing that should dominate and `compare` for another chart that should be compared with it.

Supported object types in this prototype: `chart`, `metric`, `progress`, `diagram`, `document`, `code`, `message`, `note`.

Everything else belongs to the renderer. The controller keeps semantic scene state and recomposes automatically.
