import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ApprovalView } from "./api";
import { auth } from "./auth";
import "./styles.css";
type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};
export function App() {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [approvalId, setApprovalId] = useState("");
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [managerMessage, setManagerMessage] = useState("");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeMessage, setKnowledgeMessage] = useState("");
  const chat = useMutation({
    mutationFn: api.chat,
    onSuccess: (result) => {
      const citations = [...new Set(result.citations)];
      const suffix = citations.length
        ? `\n\nSources : ${citations.join(", ")}`
        : "";
      setHistory((current) => [
        ...current,
        {
          role: "assistant",
          text: `${result.text}${suffix}`,
        },
      ]);
    },
  });
  const loadApproval = useMutation({
    mutationFn: api.getApproval,
    onSuccess: (result) => {
      setApproval(result);
      setManagerMessage("");
    },
    onError: (error) => {
      setManagerMessage(error.message);
    },
  });
  const approve = useMutation({
    mutationFn: api.approve,
    onSuccess: async () => {
      setManagerMessage("Approbation enregistrée.");
      setApproval(await api.getApproval(approvalId));
    },
    onError: (error) => {
      setManagerMessage(error.message);
    },
  });
  const execute = useMutation({
    mutationFn: api.execute,
    onSuccess: async (result) => {
      setManagerMessage(`Remboursement exécuté : ${result.providerRefundId}`);
      setApproval(await api.getApproval(approvalId));
    },
    onError: (error) => {
      setManagerMessage(error.message);
    },
  });
  const submitKnowledge = useMutation({
    mutationFn: api.submitKnowledge,
    onSuccess: (result) => {
      setKnowledgeMessage(`Document en file : ${result.documentKey}`);
      setKnowledgeTitle("");
      setKnowledgeText("");
    },
    onError: (error) => {
      setKnowledgeMessage(error.message);
    },
  });
  function sendMessage(): void {
    const text = message.trim();
    if (!text || chat.isPending) {
      return;
    }
    setHistory((current) => [...current, { role: "user", text }]);
    setMessage("");
    chat.mutate(text);
  }
  return (
    <main className="shell">
      <header>
        <div>
          <strong>Helio Resolve</strong>
          <span>Support agentique avec approbation humaine</span>
        </div>
        <button onClick={() => void auth.logout()}>Déconnexion</button>
      </header>
      <div className="workspace">
        <section className="chatPanel">
          <div className="chat">
            {history.length === 0 && (
              <div className="empty">
                Demande un statut de commande, une recherche documentaire, un
                ticket ou une proposition de remboursement.
              </div>
            )}
            {history.map((item, index) => (
              <article key={index} className={item.role}>
                <b>{item.role === "user" ? "Vous" : "Helio"}</b>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
          <div className="composer">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ex : Peux-tu vérifier la commande ord_ABC123 ?"
            />
            <button disabled={chat.isPending} onClick={sendMessage}>
              {chat.isPending ? "Réflexion..." : "Envoyer"}
            </button>
          </div>
        </section>
        <aside className="approvalPanel">
          <h2>Approbation manager</h2>
          <p>
            L’agent peut proposer un remboursement, mais il ne peut jamais
            l’exécuter seul.
          </p>
          <label htmlFor="approval-id">Approval ID</label>
          <input
            id="approval-id"
            value={approvalId}
            onChange={(event) => setApprovalId(event.target.value)}
            placeholder="apr_..."
          />
          <button
            disabled={!approvalId || loadApproval.isPending}
            onClick={() => loadApproval.mutate(approvalId)}
          >
            Charger
          </button>
          {approval && (
            <div className="approvalCard">
              <dl>
                <dt>Commande</dt>
                <dd>{approval.orderId}</dd>
                <dt>Statut</dt>
                <dd>{approval.status}</dd>
                <dt>Raison</dt>
                <dd>{approval.reason}</dd>
              </dl>
              <div className="approvalActions">
                <button
                  disabled={approval.status !== "pending" || approve.isPending}
                  onClick={() => approve.mutate(approval.id)}
                >
                  Approuver
                </button>
                <button
                  disabled={approval.status !== "approved" || execute.isPending}
                  onClick={() => execute.mutate(approval.id)}
                >
                  Exécuter le remboursement
                </button>
              </div>
            </div>
          )}
          {managerMessage && (
            <div className="managerMessage">{managerMessage}</div>
          )}
          <hr />
          <h2>Base de connaissances</h2>
          <p>
            Réservé au rôle tenant_admin. Le texte est stocké dans S3, envoyé
            dans SQS puis vectorisé par le worker.
          </p>
          <input
            value={knowledgeTitle}
            onChange={(event) => setKnowledgeTitle(event.target.value)}
            placeholder="Titre du document"
          />
          <textarea
            value={knowledgeText}
            onChange={(event) => setKnowledgeText(event.target.value)}
            placeholder="Contenu à indexer..."
          />
          <button
            disabled={
              knowledgeTitle.trim().length < 3 ||
              knowledgeText.trim().length < 20 ||
              submitKnowledge.isPending
            }
            onClick={() =>
              submitKnowledge.mutate({
                title: knowledgeTitle.trim(),
                text: knowledgeText.trim(),
              })
            }
          >
            Envoyer pour indexation
          </button>
          {knowledgeMessage && (
            <div className="managerMessage">{knowledgeMessage}</div>
          )}
        </aside>
      </div>
    </main>
  );
}
