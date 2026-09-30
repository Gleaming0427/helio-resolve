import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Document, type DocumentDetail } from "./api";
import { canDelete, documentNotice } from "./documentStatus";

const statuses: Record<string, string> = { draft: "Brouillon", queued: "En attente", processing: "Indexation en cours", published: "Publié", failed: "Échec d’indexation", withdrawn: "Retiré" };
export function DocumentLibrary() {
  const documents = useQuery({ queryKey: ["documents"], queryFn: api.documents, refetchInterval: 3000 });
  const [editing, setEditing] = useState<DocumentDetail | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const load = useMutation({ mutationFn: api.document, onSuccess: doc => { setEditing(doc); setTitle(doc.title); setText(doc.versions[0]?.content ?? ""); setNotice(""); } });
  const refresh = async () => { await documents.refetch(); };
  const save = useMutation({ mutationFn: api.saveDocument, onSuccess: async doc => { setNotice("Brouillon enregistré. Cliquez sur Publier pour le rendre disponible à l’assistant."); setEditing(await api.document(doc.id)); await refresh(); } });
  const publish = useMutation({ mutationFn: api.publishDocument, onSuccess: async () => { setNotice("Publication demandée. Le document sera disponible après son indexation."); await refresh(); } });
  const withdraw = useMutation({ mutationFn: api.withdrawDocument, onSuccess: async () => { setNotice("Document retiré des prochaines recherches de l’assistant."); await refresh(); } });
  const remove = useMutation({ mutationFn: api.deleteDocument, onSuccess: async (_result, id) => {
    if (editing?.id === id) { setEditing(null); setTitle(""); setText(""); }
    setNotice("Document supprimé avec son historique."); await refresh();
  } });
  const confirmRemove = (doc: Document) => {
    if (confirm(`Supprimer définitivement « ${doc.title} » et toutes ses versions ?`)) remove.mutate(doc.id);
  };
  const busy = save.isPending || publish.isPending || withdraw.isPending || load.isPending || remove.isPending;
  return <section className="approvalPanel panel"><h2>Bibliothèque documentaire</h2><p>Enregistrez un brouillon, relisez-le puis publiez-le. Une modification reste en brouillon jusqu’à sa publication ; la version publiée précédente reste consultable.</p>
    {documents.error && <p role="alert">{documents.error.message}</p>}
    {documents.isPending && <p role="status">Chargement…</p>}
    {documents.data?.length === 0 && <p>Aucun document pour le moment.</p>}
    {documents.data?.map(doc => <div className="documentRow" key={doc.id}><span><b>{doc.title}</b><small>Version {doc.currentVersion} · {statuses[doc.status] ?? doc.status}</small><small>{doc.publishedVersion ? `Version ${doc.publishedVersion} disponible dans le chat` : "Non disponible dans le chat"}</small>{documentNotice(doc) && <small role="alert">{documentNotice(doc)}</small>}</span><div className="approvalActions"><button disabled={busy} onClick={() => load.mutate(doc.id)}>Ouvrir</button>{["draft", "failed", "withdrawn"].includes(doc.status) && <button disabled={busy} onClick={() => publish.mutate(doc)}>{doc.status === "failed" ? "Réessayer" : "Publier"}</button>}{(doc.publishedVersion || ["queued", "processing"].includes(doc.status)) && <button disabled={busy} onClick={() => withdraw.mutate(doc.id)}>Retirer</button>}{canDelete(doc) && <button disabled={busy} onClick={() => confirmRemove(doc)}>Supprimer</button>}</div></div>)}
    <h3>{editing ? `Modifier : ${editing.title}` : "Nouveau document"}</h3>
    {editing && <button disabled={busy} onClick={() => { setEditing(null); setTitle(""); setText(""); }}>Créer un autre document</button>}
    <form onSubmit={event => { event.preventDefault(); save.mutate({ title: title.trim(), text: text.trim(), ...(editing ? { id: editing.id, expectedVersion: editing.currentVersion } : {}) }); }}>
      <label htmlFor="doc-title">Titre</label><input id="doc-title" required minLength={3} maxLength={300} value={title} onChange={e => setTitle(e.target.value)} />
      <label htmlFor="doc-text">Procédure</label><textarea id="doc-text" required minLength={20} maxLength={100000} value={text} onChange={e => setText(e.target.value)} />
      <button disabled={busy || title.trim().length < 3 || text.trim().length < 20}>Enregistrer le brouillon</button>
    </form>
    {editing && <details><summary>Historique du document</summary>{editing.versions.map(v => <div key={v.version}><h4>Version {v.version} · {v.title}</h4><small>{new Date(v.createdAt).toLocaleString()}</small><p className="documentText">{v.content}</p><button disabled={busy} onClick={() => { setTitle(v.title); setText(v.content); }}>Reprendre cette version dans le formulaire</button></div>)}</details>}
    {notice && <p role="status">{notice}</p>}{[load.error, save.error, publish.error, withdraw.error, remove.error].filter(Boolean).map((error, i) => <p role="alert" key={i}>{error?.message}</p>)}
  </section>;
}
