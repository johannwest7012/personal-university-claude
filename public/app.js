const app = document.getElementById("app");
const LETTERS = ["A", "B", "C", "D"];

function render(...nodes) {
  app.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { data });
  return data;
}

function topBar(left) {
  const onProgress = location.hash === "#progress";
  return h("header", { class: "top" },
    h("span", { class: "meta" }, left),
    h("a", { href: onProgress ? "#" : "#progress" }, onProgress ? "Quiz" : "Progress"),
  );
}

// ---------- Quiz ----------

async function showQuestion() {
  const data = await api("/api/next");
  if (data.empty) {
    render(topBar(""), h("p", { class: "empty" }, data.empty));
    return;
  }
  const { question: q, kind } = data;
  let choice = null;

  const kindLabel = { new: "new", review: "review", practice: "extra practice" }[kind];
  const options = q.options.map((text, i) =>
    h("button", { class: "option", type: "button", onclick: () => select(i) },
      h("span", { class: "letter" }, LETTERS[i]), h("span", {}, text)),
  );
  const reasoning = h("textarea", {
    placeholder: "Explain your thinking (optional)",
    "aria-label": "Your reasoning",
    rows: 3,
  });
  const submit = h("button", { class: "btn", type: "button", disabled: true, onclick: () => answer() }, "Submit");

  function select(i) {
    choice = i;
    options.forEach((o, j) => o.classList.toggle("selected", i === j));
    submit.disabled = false;
  }

  render(
    topBar([data.source, " · ", data.chapter, h("span", { class: "tag" }, kindLabel)]),
    h("p", { class: "prompt" }, q.prompt),
    h("div", { class: "options" }, options),
    data.feedbackAvailable
      ? [reasoning, h("p", { class: "hint" }, "Tap the mic on your keyboard to talk it through. The tutor will respond to your reasoning.")]
      : null,
    submit,
  );
  window.scrollTo(0, 0);

  async function answer() {
    submit.disabled = true;
    const text = reasoning.value.trim();
    const result = await api("/api/answer", {
      questionId: q.id, choice: q.options[choice], reasoning: text || undefined, kind,
    });
    showResult({ q, data, choice, text, result, options });
  }
}

function showResult({ q, data, choice, text, result, options }) {
  options.forEach((o, i) => {
    o.disabled = true;
    o.classList.remove("selected");
    const isAnswer = q.options[i] === result.answer;
    if (isAnswer) o.classList.add("right");
    else if (i === choice) o.classList.add("wrong");
    else o.classList.add("dim");
  });

  const tutor = result.feedbackPending
    ? h("div", { class: "card" }, h("h3", {}, "Tutor"), h("p", { class: "loading" }, "Reading your reasoning"))
    : null;
  if (tutor) {
    api(`/api/feedback/${result.attemptId}`, {})
      .then((f) => tutor.replaceChildren(h("h3", {}, "Tutor"), ...f.feedback.split(/\n+/).map((p) => h("p", {}, p))))
      .catch((err) => tutor.replaceChildren(h("h3", {}, "Tutor"), h("p", { class: "hint" }, err.message)));
  }

  const next = h("button", { class: "btn", type: "button", onclick: () => run(showQuestion) }, "Next question");
  const kill = h("button", {
    class: "btn quiet", type: "button",
    onclick: async () => {
      if (!confirm("Stop asking about this idea? It won't come up again.")) return;
      await api(`/api/concepts/${encodeURIComponent(q.id.split("/").slice(0, -1).join("/"))}/kill`, {});
      kill.textContent = "Won't ask again";
      kill.disabled = true;
    },
  }, "Not worth knowing");
  const flag = h("button", {
    class: "btn quiet", type: "button",
    onclick: async () => {
      const note = prompt("What's wrong with this question? (optional)");
      if (note === null) return;
      await api(`/api/questions/${encodeURIComponent(q.id)}/flag`, { note });
      flag.textContent = "Flagged";
      flag.disabled = true;
    },
  }, "Flag question");

  render(
    topBar([data.source, " · ", data.chapter]),
    h("p", { class: "prompt" }, q.prompt),
    h("div", { class: "options" }, options),
    h("p", { class: `verdict ${result.correct ? "right" : "wrong"}` }, result.correct ? "Correct" : "Not quite"),
    text ? h("p", { class: "your-reasoning" }, `“${text}”`) : null,
    tutor,
    h("div", { class: "card" },
      h("h3", {}, "Why"),
      !result.correct && result.chosenWhy ? h("p", {}, h("strong", {}, "Your pick: "), result.chosenWhy) : null,
      h("p", {}, result.correct ? null : h("strong", {}, "The answer: "), result.why),
      h("details", {}, h("summary", {}, "From the book"), h("blockquote", {}, result.passage)),
    ),
    next,
    h("div", { class: "row" }, kill, flag),
  );
  next.focus({ preventScroll: true });
}

// ---------- Progress ----------

async function showProgress() {
  const data = await api("/api/progress");
  const pct = data.totals.attempts ? Math.round((100 * data.totals.correct) / data.totals.attempts) : 0;

  render(
    topBar("Progress"),
    h("p", { class: "sub" }, `${data.totals.attempts} answers so far, ${pct}% correct.`),
    ...data.sources.map((s) => h("section", {},
      h("h1", {}, s.title.split(":")[0]),
      h("p", { class: "sub" }, s.authors),
      ...s.chapters.map(chapterView),
    )),
  );
}

function chapterView(ch) {
  const live = ch.concepts.filter((c) => c.status !== "dropped");
  const count = (s) => live.filter((c) => c.status === s).length;
  const toggle = h("button", {
    class: `toggle ${ch.read ? "on" : ""}`,
    type: "button",
    disabled: !ch.hasBank && !ch.read,
    title: ch.hasBank ? null : "Questions for this chapter haven't been generated yet",
    onclick: async () => {
      await api(`/api/chapters/${encodeURIComponent(ch.id)}/read`, { read: !ch.read });
      run(showProgress);
    },
  }, ch.read ? "Read ✓" : "Mark read");

  const label = ch.number === 0 ? "Introduction" : ch.number === 13 ? "Conclusion" : `Chapter ${ch.number}`;
  const head = h("div", { class: "chapter-head" },
    h("div", { class: "chapter-title" }, ch.title.replace(/^(Introduction|Conclusion): /, ""), h("small", {}, label)),
    toggle,
  );
  if (!ch.hasBank) return h("div", { class: "chapter" }, head, h("p", { class: "legend" }, "No questions yet"));

  const solid = count("solid");
  const learning = count("learning");
  const fading = count("fading");
  const fresh = count("new");
  const width = (n) => `width:${(100 * n) / Math.max(live.length, 1)}%`;
  return h("div", { class: "chapter" },
    head,
    h("div", { class: "bar" },
      h("span", { class: "s-solid", style: width(solid) }),
      h("span", { class: "s-learning", style: width(learning) }),
      h("span", { class: "s-fading", style: width(fading) })),
    h("p", { class: "legend" }, `${solid} solid · ${learning} learning · ${fading} due for review · ${fresh} not yet asked`),
    h("details", {},
      h("summary", {}, `${live.length} ideas`),
      h("ul", { class: "concepts" }, ch.concepts.map((c) =>
        h("li", {},
          h("span", { class: `dot ${c.status}`, title: c.status }),
          h("span", {}, c.statement.split(/(?<=\.)\s/)[0]),
          c.attempts ? h("span", { class: "stat" }, `${c.correct}/${c.attempts}`) : null,
        ),
      )),
    ),
  );
}

// ---------- Routing ----------

async function run(view) {
  try {
    await view();
  } catch (err) {
    if (err.message === "unauthorized") return;
    render(topBar(""), h("p", { class: "empty" }, "Something went wrong. ", h("a", { href: "", onclick: () => location.reload() }, "Try again")));
    console.error(err);
  }
}

function route() {
  run(location.hash === "#progress" ? showProgress : showQuestion);
}
window.addEventListener("hashchange", route);
route();
