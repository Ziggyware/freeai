const INFERENCE_URL = "https://router.val.run";

export default async function (): Promise<Response> {
  const res = await fetch(INFERENCE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "Hello — testing inference." },
      ],
    }),
  });

  /*example response:

  {"id":"chatcmpl-omni-1600e4d2-90ed-4b01-ade3-3ae3a1e3b239","object":"chat.completion","created":1777700178,"model":"qwen/qwen3-32b","choices":[{"index":0,"message":{"role":"assistant","content":"<think>\nOkay, the user sent \"Hello — testing inference.\" Let me break this down. First, they're greeting me, which is standard. The phrase \"testing inference\" is key here. They probably want to see how I handle a query that's not straightforward. Maybe they're checking if I can infer the intent behind a vague message.\n\nI should consider possible scenarios. Are they testing if I can ask clarifying questions? Or maybe they want to see if I can generate a response without more context. Since the message is short, I need to respond in a way that invites them to provide more details. \n\nI should acknowledge their greeting and then ask what specific aspect of inference they're testing. That way, I can tailor my response to their actual needs. Also, making sure the tone is friendly and helpful is important. Let me check if there's any other nuance I might be missing. Maybe they're a developer testing the model's capabilities? Or a student trying to understand how inference works in practice. \n\nEither way, the best approach is to be open and ask for clarification. That way, I can provide a more accurate and useful response. I'll go with that.\n</think>\n\nHello! It seems like you're testing how I handle inference or interpretation. Could you clarify what specific aspect you'd like me to demonstrate or explain? For example:  \n\n- Are you testing my ability to infer intent from ambiguous input?  \n- Do you want an example of logical inference?  \n- Are you curious about how I process context or generate responses?  \n\nLet me know how I can assist! 😊"},"finish_reason":"stop"}],"_omni_meta":{"provider":{"id":3,"name":"groq","base":"https://api.groq.com/openai/v1","keyEnv":"GROQ_API_KEY","fallbackModel":"llama-3.3-70b-versatile","priority":3},"latency_ms":936,"inflight_requests":0,"circuit_states":[{"name":"openrouter_free","state":"CLOSED"},{"name":"sambanova","state":"CLOSED"},{"name":"groq","state":"CLOSED"},{"name":"github_models","state":"CLOSED"},{"name":"mistral","state":"CLOSED"},{"name":"siliconflow","state":"CLOSED"},{"name":"deepinfra","state":"CLOSED"},{"name":"cerebras","state":"CLOSED"}]}}
  */

  return res //?.choices?.[0]?.message?.content,
  ; //provider: res?._omni_meta?.providerId ?? null,});
}