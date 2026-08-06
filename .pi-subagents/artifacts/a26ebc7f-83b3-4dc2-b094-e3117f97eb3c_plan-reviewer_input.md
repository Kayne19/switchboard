# Task for plan-reviewer

Re-review the updated `/home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/plan_v11.md` after the targeted corrections. Read `review_v11.md` and verify only these five items against the repository: (1) one concrete ValidatedSshTarget validator is used by remote_argv, list_models_argv, run_prepare, and upload_extension_with; (2) SWITCHBOARD_SPEECH_DEADLINE_MS is positively bounded and one absolute cancellation/deadline covers /speak, process_speech, regular synthesize_reply_if_current, and Speaker/HttpTtsTransport; (3) stale process_clips emits an existing ID-bearing stale_epoch error and browser outbox/reconnect removes it; (4) snapshot diagram framing is conditional and preserves current wire shapes; (5) docs correct speak-completion semantics and document per-process SWITCHBOARD_SESSION_TOKEN versus persistent session ID. If these are explicit and no earlier invariant was damaged, end `VERDICT: APPROVE`; otherwise list only concrete blockers and end `VERDICT: REVISE`. Read-only.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1786002388285300339_3730916_0/review_v11_final.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.