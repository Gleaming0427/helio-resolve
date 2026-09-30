import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type AgentAction, type ConversationMessage } from "./api";
import { auth, demoMembers } from "./auth";
import "./styles.css";
import { Approvals } from "./Approvals";
import { WorkspaceAdmin } from "./WorkspaceAdmin";
import { DocumentLibrary } from "./DocumentLibrary";
import { InvitationAccept } from "./InvitationAccept";
import { Tickets } from "./Tickets";
import { canOpen, viewFromHash } from "./views";

// The current conversation survives a reload of the tab; the server keeps its history.
const CONVERSATION_KEY = "helio-conversation";
const storedConversation = () => { try { return sessionStorage.getItem(CONVERSATION_KEY); } catch { return null; } };
const storeConversation = (id: string | null) => {
  try { if (id) sessionStorage.setItem(CONVERSATION_KEY, id); else sessionStorage.removeItem(CONVERSATION_KEY); } catch { /* private mode */ }
};
const headings: Record<string, [string, string, string]> = {
  chat: ["Traitez vos demandes", "depuis un seul espace.", "Posez une question sur une commande ou vos procédures. L’assistant garde le fil de la conversation, crée un ticket ou prépare un remboursement à approuver."],
  tickets: ["Suivez les demandes", "qui attendent une personne.", "Les tickets créés depuis l’assistant, avec leur commande. Marquez-les résolus une fois traités."],
  approvals: ["Vérifiez chaque demande", "de remboursement.", "Une autre personne que l’auteur approuve la proposition, puis le remboursement est exécuté dans la boutique, une seule fois."],
  knowledge: ["Ajoutez les documents", "que votre équipe utilise.", "Livraison, retours, garanties : ajoutez vos procédures pour les retrouver dans les réponses, avec leurs sources."],
  settings: ["Configurez votre", "espace SAV.", "Connectez votre boutique, réglez le ton des réponses, le seuil d’approbation et les membres de votre équipe."],
};

export function App() {
  const [requestedView, setRequestedView] = useState(() => viewFromHash(location.hash));
  const setView = (next: string) => {
    setRequestedView(next);
    window.history.replaceState(null, "", next === "chat" ? location.pathname + location.search : `#${next}`);
  };
  const invitation = sessionStorage.getItem("helio-invitation");
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: !invitation, retry: false });
  const cache = useQueryClient();
  const currentEmail = me.data?.email;
  // Lets administrators recognise members. Best effort: the member list falls back to
  // the identifier, and the next page load retries.
  useEffect(() => {
    if (currentEmail === undefined) return;
    void auth.identity().then(async identity => {
      if (!identity || identity.email === currentEmail) return;
      await api.syncEmail(identity.idToken);
      await cache.invalidateQueries({ queryKey: ["me"] });
    }).catch(() => undefined);
  }, [currentEmail, cache]);
  const admin = me.data?.roles.includes("tenant_admin");
  const manager = me.data?.roles.includes("support_manager");
  const view = canOpen(requestedView, me.data?.roles ?? []) ? requestedView : "chat";
  const [focusApproval, setFocusApproval] = useState<string | null>(null);
  const [focusTicket, setFocusTicket] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(storedConversation);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, enabled: !!me.data });
  const saved = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => api.conversation(conversationId!), enabled: !!me.data && !!conversationId, retry: false });
  useEffect(() => { if (saved.data) setMessages(saved.data.messages); }, [saved.data]);
  // A conversation that no longer exists (or belongs to someone else) is simply dropped.
  useEffect(() => { if (saved.error) openConversation(null); }, [saved.error]);
  function openConversation(id: string | null) {
    storeConversation(id);
    setConversationId(id);
    if (!id) setMessages([]);
  }
  const chat = useMutation({
    mutationFn: api.chat,
    onSuccess: async (result) => {
      setMessages(current => [...current, { role: "assistant", text: result.text, citations: [...new Set(result.citations)], actions: result.actions }]);
      storeConversation(result.conversationId);
      setConversationId(result.conversationId);
      await cache.invalidateQueries({ queryKey: ["conversation", result.conversationId] });
      await cache.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  function sendMessage(): void {
    const text = message.trim();
    if (!text || chat.isPending) return;
    setMessages(current => [...current, { role: "user", text, citations: [], actions: [] }]);
    setMessage("");
    chat.mutate({ message: text, conversationId: conversationId ?? undefined });
  }
  function ActionLink({ action }: { action: AgentAction }) {
    if (action.type === "ticket_created") {
      return <button onClick={() => { setFocusTicket(action.ticketId); setView("tickets"); }}>Voir le ticket {action.ticketId} ↗</button>;
    }
    return manager
      ? <button onClick={() => { setFocusApproval(action.approvalId); setView("approvals"); }}>Ouvrir la proposition {action.approvalId} ↗</button>
      : <small>Proposition {action.approvalId} transmise à un manager pour approbation.</small>;
  }

  if (invitation) return <InvitationAccept token={invitation} />;
  if (me.isPending) return <p role="status">Chargement de votre espace…</p>;
  if (me.error) return <main className="approvalPanel panel"><h1>Accès à votre espace</h1><p role="alert">{me.error.message}</p><p>Demandez un lien d’invitation à votre administrateur si vous n’avez pas encore rejoint votre équipe.</p><button onClick={() => void me.refetch()}>Réessayer</button>{!auth.isDev && <button onClick={() => void auth.logout()}>Déconnexion</button>}</main>;
  const [title, emphasis, intro] = headings[view]!;
  return (
    <div className="shell">
      <header>
        <div>
          <strong><i className="brandMark">h</i> helio <small>resolve</small></strong>
        </div>
        {auth.isDev
          ? <label className="sessionBadge">Démonstration · agir en tant que{" "}
              <select aria-label="Membre de démonstration" value={me.data.userId} onChange={e => { auth.setDevUser(e.target.value); location.reload(); }}>
                {demoMembers.map(member => <option key={member.userId} value={member.userId}>{member.label}</option>)}
              </select>
            </label>
          : <button onClick={() => void auth.logout()}>Déconnexion</button>}
      </header>
      <aside className="sidebar"><p className="navLabel">VOTRE ESPACE</p><nav aria-label="Navigation principale">{[["chat", "✧", "Assistant"], ["tickets", "☰", "Tickets"], ["approvals", "✓", "Approbations"], ["knowledge", "▤", "Documents"], ["settings", "⚙", "Réglages"]].filter(([id]) => canOpen(id!, me.data?.roles ?? [])).map(([id, icon, label]) => <button key={id} className={view === id ? "navItem active" : "navItem"} aria-current={view === id ? "page" : undefined} onClick={() => setView(id!)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav><div className="sidebarNote"><span>✧</span><b>Un remboursement à vérifier ?</b><p>Les propositions créées par l’assistant attendent dans Approbations.</p></div><div className="sidebarFoot">Helio Resolve<br /><span>Votre espace SAV</span></div></aside>
      <main className="workspace">
        <div className="pageHeading"><span className="eyebrow">HELIO RESOLVE · SUPPORT CLIENT</span><h1>{title}<br /><em>{emphasis}</em></h1><p>{intro}</p></div>
        <section className="chatPanel panel" hidden={view !== "chat"} aria-label="Assistant support">
          <div className="panelHeading">
            <span>● &nbsp; Assistant Helio</span>
            <span className="conversationControls">
              {!!conversations.data?.length && <select aria-label="Reprendre une conversation" value={conversationId ?? ""} onChange={e => openConversation(e.target.value || null)}>
                <option value="">Conversations récentes…</option>
                {conversations.data.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>}
              <button disabled={chat.isPending || !conversationId} onClick={() => openConversation(null)}>Nouvelle conversation</button>
            </span>
          </div>
          <div className="chat">
            {messages.length === 0 && !saved.isFetching && (
              <div className="empty">
                <div className="heroIcon" aria-hidden="true">✧</div><h2>Quelle demande souhaitez-vous traiter ?</h2><p>Indiquez le numéro de commande ou décrivez le problème.<br />Vous pouvez aussi partir d’un exemple ci-dessous.</p>
                <div className="suggestions">{[["Suivre une commande", "Peux-tu vérifier la commande #1001 ?"], ["Chercher une information", "Selon notre documentation, quels sont les délais de livraison ?"], ["Préparer un remboursement", "Propose un remboursement pour la commande #1001 : le produit est arrivé endommagé."]].map(([label, prompt]) => <button key={label} onClick={() => setMessage(prompt!)}>{label} ↗</button>)}</div>
              </div>
            )}
            {saved.isFetching && messages.length === 0 && <p role="status">Chargement de la conversation…</p>}
            {messages.map((item, index) => (
              <article key={index} className={item.role}>
                <b>{item.role === "user" ? "Vous" : "Helio"}</b>
                <p>{item.text}</p>
                {item.citations.length > 0 && <small>Sources : {item.citations.join(", ")}</small>}
                {item.actions.length > 0 && <div className="approvalActions">{item.actions.map((action, i) => <ActionLink key={i} action={action} />)}</div>}
              </article>
            ))}
          </div>
          {chat.isPending && <p className="feedback" role="status">Helio prépare votre réponse…</p>}
          {chat.isError && <p className="feedback error" role="alert">La demande n’a pas abouti : {chat.error.message}</p>}
          <div className="composer">
            <textarea
              aria-label="Votre message à Helio"
              maxLength={4000}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendMessage(); }}
              placeholder="Ex. Où en est la commande #1001 ?"
            />
            <button disabled={chat.isPending || !message.trim()} onClick={sendMessage}>
              {chat.isPending ? "Réflexion…" : "Envoyer ↗"}
            </button>
          </div>
        </section>
        {view === "tickets" && <Tickets userId={me.data.userId} focus={focusTicket} />}
        {view === "approvals" && manager && <Approvals userId={me.data.userId} focus={focusApproval} />}
        {view === "knowledge" && admin && <DocumentLibrary />}
        {view === "settings" && admin && <WorkspaceAdmin />}
        <div className="trustRow"><span>▤ Consultez les sources</span><span>✓ Vérifiez les propositions</span><span>↗ Passez à l’action</span></div><footer>Vérifiez les informations de la réponse avant de les transmettre à un client.</footer>
      </main>
    </div>
  );
}
