import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import { MODEL_ROUTING_CHANGED_EVENT, ModelSettingsClient, type EffectiveModelRoute } from "../../api/models";
import { ProductionClient, type AssistantAnswer, type AssistantQuestionContext, type AssistantStatus } from "../../api/production";

type AssistantTurn = { id: number; role: "user" | "assistant"; text: string; answer?: AssistantAnswer };
type Command = "ask" | "cycle" | "clear";

export function useAssistantConversation(baseUrl: string, projectId: string) {
  const client = useMemo(() => baseUrl && projectId ? new ProductionClient(baseUrl) : null, [baseUrl, projectId]);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [loading, setLoading] = useState(Boolean(client));
  const [command, setCommand] = useState<Command | null>(null);
  const [message, setMessage] = useState("");
  const nextTurnId = useRef(0);
  const generation = useRef(0);
  const running = useRef(false);
  const controlsLocked = loading || command !== null || !client;

  useEffect(() => {
    const current = ++generation.current;
    running.current = false;
    setCommand(null);
    setMessage("");
    setStatus(null);
    setTurns([]);
    setLoading(Boolean(client));
    if (client) {
      void client.assistant(projectId).then((next) => {
        if (generation.current !== current) return;
        setStatus(next);
        setTurns((next.messages ?? []).map((item) => ({
          id: nextTurnId.current++,
          role: item.role === "user" ? "user" : "assistant",
          text: item.text,
          answer: item.role === "assistant" ? {
            context: item.context,
            diagnosis: item.diagnosis,
            answer_mode: item.answer_mode,
            suggested_actions: item.suggested_actions,
            retrieval: { results: item.evidence },
          } : undefined,
        })));
      }).catch((error) => {
        if (generation.current === current) setMessage(errorMessage(error));
      }).finally(() => {
        if (generation.current === current) setLoading(false);
      });
    }
    return () => { generation.current += 1; };
  }, [client, projectId]);

  const items = useMemo(() => [...(status?.items ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)), [status]);

  function addTurn(turn: Omit<AssistantTurn, "id">) {
    const id = nextTurnId.current++;
    setTurns((current) => [...current, { ...turn, id }]);
  }

  function run<T>(next: Command, work: (connection: ProductionClient) => Promise<T>, apply: (result: T) => void, feedback = "") {
    if (!client || controlsLocked || running.current) return false;
    running.current = true;
    const current = generation.current;
    setCommand(next);
    setMessage(feedback);
    void (async () => {
      try {
        const result = await work(client);
        if (generation.current === current) apply(result);
      } catch (error) {
        if (generation.current === current) setMessage(errorMessage(error));
      } finally {
        if (generation.current === current) {
          running.current = false;
          setCommand(null);
        }
      }
    })();
    return true;
  }

  function ask(question: string, context: AssistantQuestionContext) {
    if (!question) return false;
    return run("ask", (connection) => {
      addTurn({ role: "user", text: question });
      return connection.messageAssistant(projectId, question, context);
    }, (answer) => {
      addTurn({ role: "assistant", text: (answer.answer ?? answer.message ?? answer.text) || "小镜未返回可阅读的回答。", answer });
    });
  }

  function clear() {
    if (!turns.length) return false;
    return run("clear", (connection) => connection.clearAssistant(projectId), (next) => {
      setStatus(next);
      setTurns([]);
    });
  }

  function cycle() {
    return run("cycle", (connection) => connection.cycleAssistant(projectId, true), (next) => {
      setStatus(next);
      setMessage(`已检查 · ${next.items?.length ?? 0} 个项目事项`);
    }, "正在重新检查当前项目…");
  }

  return { status, turns, items, loading, command, controlsLocked, message, setMessage, ask, clear, cycle };
}

export function useAssistantTextRoute(baseUrl: string, active = true) {
  const [route, setRoute] = useState<EffectiveModelRoute | null>(null);
  useEffect(() => {
    if (!baseUrl || !active) return;
    let request = 0;
    async function refresh() {
      const current = ++request;
      try {
        const payload = await new ModelSettingsClient(baseUrl).read();
        if (request === current) setRoute(payload.routing?.text ?? null);
      } catch {
        if (request === current) setRoute(null);
      }
    }
    void refresh();
    window.addEventListener(MODEL_ROUTING_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      request++;
      window.removeEventListener(MODEL_ROUTING_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [active, baseUrl]);
  return route;
}

export function useAssistantCopy<T>(onFailure: () => void) {
  const [copied, setCopied] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy(id: T, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (!active.current) return;
      setCopied(id);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    } catch {
      if (active.current) onFailure();
    }
  }
  return { copied, copy };
}
