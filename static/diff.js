import { getElement, registerRenderer, setCaption, showStageError, } from "./stage.js";
export function parseUnifiedDiff(source) {
    if (!source || typeof source !== "string")
        return [];
    const rawLines = source.split("\n");
    const files = [];
    let currentFile = null;
    let currentHunk = null;
    let state = "OUTSIDE";
    let oldLeft = 0;
    let newLeft = 0;
    let oldLine = 0;
    let newLine = 0;
    for (let idx = 0; idx < rawLines.length; idx++) {
        const line = rawLines[idx];
        if (state === "OUTSIDE") {
            if (line.startsWith("\\")) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentHunk.lines[currentHunk.lines.length - 1].noNewline = true;
                }
                continue;
            }
            if (line.startsWith("diff --git ")) {
                currentFile = { hunks: [] };
                files.push(currentFile);
                currentHunk = null;
                continue;
            }
            if (line.startsWith("--- ")) {
                if (!currentFile) {
                    currentFile = { hunks: [] };
                    files.push(currentFile);
                }
                currentFile.oldPath = line.slice(4).trim();
                continue;
            }
            if (line.startsWith("+++ ")) {
                if (!currentFile) {
                    currentFile = { hunks: [] };
                    files.push(currentFile);
                }
                currentFile.newPath = line.slice(4).trim();
                continue;
            }
            if (line.startsWith("@@ ")) {
                const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(line);
                if (match) {
                    if (!currentFile) {
                        currentFile = { hunks: [] };
                        files.push(currentFile);
                    }
                    oldLine = parseInt(match[1], 10);
                    oldLeft = match[2] !== undefined ? parseInt(match[2], 10) : 1;
                    newLine = parseInt(match[3], 10);
                    newLeft = match[4] !== undefined ? parseInt(match[4], 10) : 1;
                    currentHunk = { header: line, lines: [] };
                    currentFile.hunks.push(currentHunk);
                    state = "INHUNK";
                }
            }
        }
        else if (state === "INHUNK") {
            if (line.startsWith("diff --git ") || line.startsWith("@@ ")) {
                state = "OUTSIDE";
                idx--;
                continue;
            }
            if (line.startsWith("\\")) {
                // Metadata line, e.g. \ No newline at end of file
                if (currentHunk && currentHunk.lines.length > 0) {
                    currentHunk.lines[currentHunk.lines.length - 1].noNewline = true;
                }
                continue;
            }
            let op;
            let text = "";
            if (line.startsWith("+")) {
                op = "add";
                text = line.slice(1);
                const row = { op, text, new: newLine++ };
                newLeft--;
                currentHunk.lines.push(row);
            }
            else if (line.startsWith("-")) {
                op = "del";
                text = line.slice(1);
                const row = { op, text, old: oldLine++ };
                oldLeft--;
                currentHunk.lines.push(row);
            }
            else {
                // ' ' context line or empty line
                op = "ctx";
                text = line.startsWith(" ") ? line.slice(1) : line;
                const row = { op, text, old: oldLine++, new: newLine++ };
                oldLeft--;
                newLeft--;
                currentHunk.lines.push(row);
            }
            if (oldLeft <= 0 && newLeft <= 0) {
                state = "OUTSIDE";
            }
        }
    }
    return files.filter((f) => f.hunks.length > 0);
}
export function diffSummary(files) {
    if (!files || files.length === 0)
        return "0 files";
    let added = 0;
    let deleted = 0;
    for (const f of files) {
        for (const h of f.hunks) {
            for (const l of h.lines) {
                if (l.op === "add")
                    added++;
                else if (l.op === "del")
                    deleted++;
            }
        }
    }
    const fileText = files.length === 1 ? "1 file" : `${files.length} files`;
    return `${fileText}, +${added} -${deleted}`;
}
export function renderDiff(msg) {
    const source = msg.source || "";
    const files = parseUnifiedDiff(source);
    const summary = diffSummary(files);
    const title = msg.title ? `${msg.title} — ${summary}` : summary;
    setCaption(title, msg.notes);
    showStageError("");
    document.body.classList.add("stage-structured");
    const canvas = getElement("stageCanvas");
    canvas.classList.add("structured");
    canvas.replaceChildren();
    const ul = document.createElement("ul");
    ul.className = "diff";
    ul.setAttribute("data-visual", "diff");
    for (const f of files) {
        const fileLi = document.createElement("li");
        fileLi.className = "diff-file";
        const pathP = document.createElement("p");
        pathP.className = "diff-path";
        const pathText = f.newPath || f.oldPath || "file";
        pathP.textContent = pathText.replace(/^[ab]\//, "");
        fileLi.appendChild(pathP);
        for (const h of f.hunks) {
            const hunkOl = document.createElement("ol");
            hunkOl.className = "diff-hunk";
            for (const l of h.lines) {
                const lineLi = document.createElement("li");
                lineLi.className = "diff-line";
                lineLi.setAttribute("data-op", l.op);
                if (l.old !== undefined)
                    lineLi.setAttribute("data-old", String(l.old));
                if (l.new !== undefined)
                    lineLi.setAttribute("data-new", String(l.new));
                const code = document.createElement("code");
                code.className = "text";
                code.textContent = l.text;
                lineLi.appendChild(code);
                if (l.op === "add") {
                    const sr = document.createElement("span");
                    sr.className = "sr-only";
                    sr.textContent = "added";
                    lineLi.appendChild(sr);
                }
                else if (l.op === "del") {
                    const sr = document.createElement("span");
                    sr.className = "sr-only";
                    sr.textContent = "removed";
                    lineLi.appendChild(sr);
                }
                hunkOl.appendChild(lineLi);
            }
            fileLi.appendChild(hunkOl);
        }
        ul.appendChild(fileLi);
    }
    canvas.appendChild(ul);
}
registerRenderer("diff", renderDiff);
