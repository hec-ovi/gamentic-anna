"""Thin client for the llama.cpp OpenAI-compatible endpoint.

One function: chat(). No framework. Returns the assistant message with parsed
tool calls. The same server + model backs every agent; only the messages differ.
"""
import json
import time
from dataclasses import dataclass, field

import httpx

from . import hostbridge
from .config import settings
from .providers import base as providers


@dataclass
class ToolCall:
    name: str
    arguments: dict


@dataclass
class LLMReply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = ""
    usage: dict = field(default_factory=dict)  # {prompt_tokens, completion_tokens, total_tokens}


def chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    tool_choice: str = "auto",
    temperature: float = 0.8,
    max_tokens: int = 400,
    stop: list[str] | None = None,
    thinking: bool | None = None,
) -> LLMReply:
    # Native Anna path: when running as an Executa, the engine reverse-RPCs the host
    # LLM directly (no HTTP gateway). Everything outside the executa (tests, plain
    # uvicorn) falls through to the unchanged HTTP path below.
    if hostbridge.active():
        return _anna_chat(messages, tools, tool_choice, temperature, stop)
    # Resolved at call time (env -> default), so a .env change lands on the
    # next compose up with no code involved.
    cfg = providers.resolve("text")
    payload: dict = {
        "model": cfg.model,
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens and max_tokens > 0:   # 0/None = uncapped: the prompt governs length
        payload["max_tokens"] = max_tokens
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice
    if stop:
        # Truncate, never error: stops are a guard, not content. Upstream llama.cpp
        # imposes NO cap (the server reads the whole "stop" array into its antiprompt
        # vector; verified against ggml-org/llama.cpp tools/server), so the local
        # max_stops=8 is OUR conservative budget (providers/base.py); the OpenAI
        # dialect hard-caps at 4. The slice keeps the FRONT of the list, and the turn
        # engine builds its scaffold stops before the cast name-stops, so under any
        # truncation the scaffold guards survive and only name-stops fall off.
        payload["stop"] = stop[:cfg.max_stops] if cfg.max_stops > 0 else stop
    if thinking and cfg.supports_thinking:
        # llama.cpp merges request-level chat_template_kwargs over the server-level ones,
        # so this enables hybrid-model reasoning for THIS call only. If the reply carries
        # message.reasoning_content, it is ignored: content stays the only consumed field.
        # Capability-gated: cloud OpenAI-dialect endpoints have no such kwarg.
        payload["chat_template_kwargs"] = {"enable_thinking": True}

    url = f"{cfg.base_url}/chat/completions"
    kwargs: dict = {"json": payload, "timeout": settings.LLM_TIMEOUT}
    if cfg.api_key:                     # local llama.cpp needs none; cloud gets Bearer
        kwargs["headers"] = {"Authorization": f"Bearer {cfg.api_key}"}
    # One retry on connection-level failures only: a redeploy of the llama.cpp container
    # kills in-flight requests (seen live), and a fresh connection a beat later succeeds.
    # Timeouts are NOT retried (a 180s timeout means the box is busy; retrying doubles
    # the pain), and HTTP status errors are real answers, not transport flakes.
    for attempt in (0, 1):
        try:
            resp = httpx.post(url, **kwargs)
            break
        except (httpx.ConnectError, httpx.RemoteProtocolError):
            if attempt:
                raise
            time.sleep(0.5)
    resp.raise_for_status()
    data = resp.json()
    choice = data["choices"][0]
    msg = choice.get("message", {})

    calls: list[ToolCall] = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except json.JSONDecodeError:
            args = {}
        calls.append(ToolCall(name=fn.get("name", ""), arguments=args))

    return LLMReply(
        content=(msg.get("content") or "").strip(),
        tool_calls=calls,
        finish_reason=choice.get("finish_reason", ""),
        usage=data.get("usage") or {},
    )


# --- Anna-native path: the engine reverse-RPCs the host LLM (no HTTP gateway) -------
# Active only when running as an Anna Executa (app.hostbridge installs the channel).
# Anna sampling has no OpenAI-style function-calling but DOES support structured JSON
# output, so when tools are offered we ask the model for a {prose, tool_calls} envelope
# (strict json_schema, with a json_object downgrade) and parse it into the SAME
# LLMReply / ToolCall the engine already consumes. Output length is never capped (see
# the no-output-cap rule); max_tokens is the host's mandatory maximum
# (hostbridge.MAX_SAMPLING_TOKENS).
#
# Why json_schema and not plain json_object: a real model left in json_object mode
# narrates state changes ("you hook the rusted ring free") instead of emitting the
# tool_call that mutates state. The strict schema FORCES the {prose, tool_calls} shape
# at inference, so take_item/give_item/move_location/spawn_character/etc. actually fire.
# Because Anna forwards the schema to the OpenAI dialect, STRICT mode applies: every
# object must set additionalProperties:false and list all properties in `required`. A
# free-form per-tool args object is therefore impossible; instead `arguments` is a JSON
# STRING the parser json.loads back (exactly how OpenAI's own function calling carries
# args). The engine still re-validates args against each tool's schema downstream.
# Two-layer floor: a model with no structured output at all returns -32010 and
# on_unsupported downgrades it to json_object; any OTHER schema rejection (-32003/-32004)
# is caught in _anna_chat and retried once in json_object mode, so a tools turn degrades
# instead of failing. The lenient parser reads the strict, the json_object, and the
# raw-prose shapes, so nothing is dropped.

# Anna L2 structured-output schema for the tool envelope. Strict mode (OpenAI dialect)
# requires every object to set additionalProperties:false and list ALL its properties in
# `required`; `arguments` is a JSON-encoded string, not an open object, so the schema is
# valid. Tiny (well under Anna's 32KB / depth-8 / 512-node caps); name matches
# ^[a-zA-Z0-9_-]{1,64}$.
_TOOL_ENVELOPE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "tool_envelope",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["prose", "tool_calls"],
            "properties": {
                "prose": {"type": "string"},
                "tool_calls": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["name", "arguments"],
                        "properties": {
                            "name": {"type": "string"},
                            # A JSON object encoded as a STRING. Strict mode (which Anna
                            # forwards to the OpenAI dialect) forbids an open object
                            # (additionalProperties:true invalidates the whole schema),
                            # so we carry per-tool args the way OpenAI's own function
                            # calling does - a JSON string the parser json.loads back.
                            "arguments": {"type": "string",
                                          "description": "A JSON object of the tool's arguments, encoded as a string."},
                        },
                    },
                },
            },
        },
    },
}


def _flatten(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for c in content:
            if isinstance(c, dict):
                out.append(c.get("text") or "")
            elif isinstance(c, str):
                out.append(c)
        return "".join(out)
    return "" if content is None else str(content)


def _to_mcp(messages: list[dict]):
    """OpenAI messages -> (system_prompt, MCP-shaped user/assistant messages)."""
    sys_parts: list[str] = []
    mcp: list[dict] = []
    for m in messages:
        role, text = m.get("role"), _flatten(m.get("content"))
        if role == "system":
            if text:
                sys_parts.append(text)
        else:
            mcp.append({"role": "assistant" if role == "assistant" else "user",
                        "content": {"type": "text", "text": text}})
    if not mcp:
        mcp = [{"role": "user", "content": {"type": "text", "text": ""}}]
    return ("\n\n".join(sys_parts) or None), mcp


def _tools_directive(tools: list[dict]) -> str:
    lines = ["You can act by calling tools. Available tools:"]
    for t in tools:
        fn = t.get("function", t)
        lines.append(f"- {fn.get('name', '')}: {fn.get('description', '')}")
        lines.append(f"  arguments JSON schema: {json.dumps(fn.get('parameters', {}), ensure_ascii=False)}")
    lines.append(
        'Reply with ONLY a single JSON object, nothing before or after it, of the form: '
        '{"prose": "<text to show the player, or an empty string>", '
        '"tool_calls": [{"name": "<tool name>", "arguments": {<arguments matching that tool\'s schema>}}]}.')
    if len(tools) == 1:
        name = tools[0].get("function", tools[0]).get("name", "")
        lines.append(f'You MUST call "{name}" with valid arguments.')
    else:
        # The model will happily NARRATE a state change in prose and leave tool_calls
        # empty (json_schema forces the shape, not a non-empty list). Make the contract
        # explicit and show it, or mechanical effects silently never happen.
        lines.append(
            'CRITICAL: "prose" is ONLY atmosphere and what the player perceives. EVERY '
            'concrete change to the world MUST be a tool call, never described in prose '
            'alone: an item taken, placed, revealed or given; moving to a location; '
            'damage or healing; a present character speaking or reacting; a new character '
            'appearing; a quest, goal, item or scene '
            'change. If your prose states that something happened, the matching tool call '
            'MUST appear in "tool_calls". Use an empty "tool_calls" list ONLY for pure '
            'description with no state change. '
            'Example: {"prose": "You pry the rusted key from the silt and pocket it.", '
            '"tool_calls": [{"name": "take_item", "arguments": {"item": "rusted key"}}]}')
    return "\n".join(lines)


def _loads_lenient(text: str):
    """Parse model JSON tolerantly. Returns a dict or list on success, else {}."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1:]
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        try:
            from json_repair import repair_json
            obj = json.loads(repair_json(text))
        except Exception:
            return {}
    return obj if isinstance(obj, (dict, list)) else {}


def _map_usage(usage) -> dict:
    usage = usage or {}
    prompt = usage.get("prompt_tokens", usage.get("inputTokens", 0)) or 0
    completion = usage.get("completion_tokens", usage.get("outputTokens", 0)) or 0
    return {"prompt_tokens": prompt, "completion_tokens": completion,
            "total_tokens": usage.get("total_tokens", prompt + completion)}


def _norm_stop(stop_reason) -> str:
    s = (stop_reason or "").lower()
    return "length" if s in ("length", "max_tokens", "maxtokens") else (stop_reason or "")


def _anna_chat(messages, tools, tool_choice, temperature, stop) -> LLMReply:
    system_prompt, mcp = _to_mcp(messages)
    response_format = None
    if tools:
        directive = _tools_directive(tools)
        system_prompt = f"{system_prompt}\n\n{directive}" if system_prompt else directive
        response_format = _TOOL_ENVELOPE_SCHEMA

    def _sample(rf):
        return hostbridge.sample_sync(
            messages=mcp, system_prompt=system_prompt, temperature=temperature,
            stop_sequences=stop or None, response_format=rf,
            on_unsupported="json_object" if rf else None)

    try:
        result = _sample(response_format)
    except Exception as exc:
        # on_unsupported only covers a model with NO structured output (-32010). A schema
        # the provider rejects as invalid surfaces as -32003/-32004 (or names "schema"),
        # which it does NOT cover - so retry ONCE in plain json_object mode rather than
        # failing the turn (the directive still shapes the envelope; the parser reads it).
        code = getattr(exc, "code", None)
        fmt_error = code in (-32003, -32004, -32010) or "schema" in f"{getattr(exc, 'message', '')} {exc}".lower()
        if response_format is None or not fmt_error:
            raise
        result = _sample({"type": "json_object"})
    content = result.get("content") or {}
    text = content.get("text", "") if isinstance(content, dict) else _flatten(content)
    usage = _map_usage(result.get("usage"))
    finish = _norm_stop(result.get("stopReason"))
    if not tools:
        return LLMReply(content=(text or "").strip(), finish_reason=finish, usage=usage)
    parsed = _loads_lenient(text)
    # accept a bare top-level array as the tool_calls list (a common forced-call shape)
    obj = {"tool_calls": parsed} if isinstance(parsed, list) else parsed
    calls: list[ToolCall] = []
    for tc in obj.get("tool_calls") or []:
        name = tc.get("name") or ""
        args = tc.get("arguments")
        if isinstance(args, str):
            args = _loads_lenient(args)
        if name:
            calls.append(ToolCall(name=name, arguments=args if isinstance(args, dict) else {}))
    prose = obj.get("prose")
    if not isinstance(prose, str):
        # No clean envelope: fall back to the raw text as prose so the engine's own
        # prose-mark / default-accept handling still drives the turn.
        prose = "" if obj else (text or "")
    return LLMReply(content=prose.strip(), tool_calls=calls, finish_reason=finish, usage=usage)
