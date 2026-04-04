/**
 * Direct HTTP calls to user-selected native providers (Gemini, MiniMax).
 * Used when task.runtimeProfile selects a non-Codex provider.
 */

export type NativeChatMessage = { role: "user" | "assistant"; content: string };

function stripDataUrlPrefix(dataUrlOrBase64: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrlOrBase64.trim());
  if (m) {
    return { mime: m[1] ?? "image/jpeg", data: m[2] ?? "" };
  }
  return { mime: "image/jpeg", data: dataUrlOrBase64.trim() };
}

/**
 * Gemini generateContent (v1beta). `model` is e.g. gemini-2.5-flash.
 */
export async function geminiGenerateContent(options: {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  messages: NativeChatMessage[];
  userImageBase64?: string;
}): Promise<{ text: string; error?: string }> {
  const modelId = options.model.replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (let i = 0; i < options.messages.length; i += 1) {
    const m = options.messages[i]!;
    const isLastUser =
      m.role === "user" && i === options.messages.length - 1 && Boolean(options.userImageBase64);
    const parts: Array<Record<string, unknown>> = [{ text: m.content }];
    if (isLastUser && options.userImageBase64) {
      const { mime, data } = stripDataUrlPrefix(options.userImageBase64);
      parts.unshift({
        inline_data: { mime_type: mime, data }
      });
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts
    });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  };
  if (options.systemInstruction?.trim()) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction.trim() }] };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  }

  const raw = (await response.json()) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  if (!response.ok) {
    return {
      text: "",
      error: raw.error?.message ?? `Gemini HTTP ${response.status}`
    };
  }

  const parts = raw.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  return { text: text.trim() };
}

/**
 * MiniMax chat via OpenAI-compatible endpoint on api.minimax.io.
 */
export async function minimaxChatCompletion(options: {
  apiKey?: string;
  accessToken?: string;
  model: string;
  systemInstruction?: string;
  messages: NativeChatMessage[];
}): Promise<{ text: string; error?: string }> {
  const token = options.apiKey?.trim() || options.accessToken?.trim();
  if (!token) {
    return { text: "", error: "MiniMax API key or access token required." };
  }

  const msgs: Array<{ role: string; content: string }> = [];
  if (options.systemInstruction?.trim()) {
    msgs.push({ role: "system", content: options.systemInstruction.trim() });
  }
  for (const m of options.messages) {
    msgs.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    });
  }

  const url = "https://api.minimax.io/v1/chat/completions";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: msgs,
        temperature: 0.7,
        max_tokens: 8192
      })
    });
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  }

  const raw = (await response.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (!response.ok) {
    return {
      text: "",
      error: raw.error?.message ?? `MiniMax HTTP ${response.status}`
    };
  }

  const text = raw.choices?.[0]?.message?.content ?? "";
  return { text: text.trim() };
}
