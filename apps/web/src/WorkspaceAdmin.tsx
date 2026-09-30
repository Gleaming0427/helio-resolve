import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Workspace } from "./api";
import { ShopifyConnection } from "./ShopifyConnection";

const roles = { support_agent: "Conseiller", support_manager: "Manager", tenant_admin: "Administrateur" };
const locales: Record<string, string> = { "fr-FR": "Français", "en-US": "English" };
const tones: Record<string, string> = { professional: "Professionnel", warm: "Chaleureux", concise: "Concis" };
const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
function Options({ labels }: { labels: Record<string, string> }) { return Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>); }
function SettingsForm({ workspace, onSaved }: { workspace: Workspace; onSaved: (version: number) => void }) {
  const cache = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [locale, setLocale] = useState(workspace.settings.locale);
  const [tone, setTone] = useState(workspace.settings.responseTone);
  const [euros, setEuros] = useState(String(workspace.settings.refundApprovalThresholdCents / 100));
  // The form remounts on each new version, so the confirmation lives in the parent.
  const save = useMutation({ mutationFn: api.updateSettings, onSuccess: async settings => { onSaved(settings.version); await cache.invalidateQueries({ queryKey: ["workspace"] }); } });
  const actor = (id: string) => workspace.members.find(m => m.userId === id)?.email ?? (id === "usr_MIGRATION" ? "migration automatique" : id);
  return <><form onSubmit={event => { event.preventDefault(); save.mutate({ name, locale, responseTone: tone, refundApprovalThresholdCents: Math.round(Number(euros) * 100), expectedVersion: workspace.settings.version }); }}>
    <label htmlFor="workspace-name">Nom de l’entreprise</label><input id="workspace-name" required minLength={2} maxLength={200} value={name} onChange={e => setName(e.target.value)} />
    <label htmlFor="locale">Langue des réponses</label><select id="locale" value={locale} onChange={e => setLocale(e.target.value)}><Options labels={locales} /></select>
    <label htmlFor="tone">Ton des réponses</label><select id="tone" value={tone} onChange={e => setTone(e.target.value)}><Options labels={tones} /></select>
    <label htmlFor="threshold">Plafond de remboursement des managers (€)</label><input id="threshold" type="number" required min="0" max="100000" step="0.01" value={euros} onChange={e => setEuros(e.target.value)} />
    <p className="fieldHelp">Au-delà de ce montant, un administrateur doit approuver et exécuter le remboursement. Les devises autres que l’euro lui sont aussi réservées.</p>
    <button disabled={save.isPending}>Enregistrer les réglages</button>
    {save.error && <p role="alert">{save.error.message}</p>}
  </form><details><summary>Historique des réglages · version {workspace.settings.version}</summary>{workspace.revisions.map(revision => <div className="documentRow" key={revision.version}><span><b>Version {revision.version} · {revision.name}</b><small>{locales[revision.locale] ?? revision.locale} · {tones[revision.responseTone] ?? revision.responseTone} · plafond {euro.format(revision.refundApprovalThresholdCents / 100)}</small><small>{new Date(revision.createdAt).toLocaleString()} · par {actor(revision.actorId)}</small></span><button type="button" onClick={() => { setName(revision.name); setLocale(revision.locale); setTone(revision.responseTone); setEuros(String(revision.refundApprovalThresholdCents / 100)); }}>Reprendre ces valeurs</button></div>)}</details></>;
}
export function WorkspaceAdmin() {
  const cache = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });
  const [role, setRole] = useState("support_agent");
  const [link, setLink] = useState("");
  const [saved, setSaved] = useState("");
  const toggleAccess = (m: Workspace["members"][number]) => {
    if (m.active && !confirm(`Suspendre l’accès de ${m.email ?? m.userId} ? Il perdra l’accès dès sa prochaine demande.`)) return;
    member.mutate({ ...m, active: !m.active });
  };
  const refresh = async () => { await cache.invalidateQueries({ queryKey: ["workspace"] }); await cache.invalidateQueries({ queryKey: ["me"] }); };
  const member = useMutation({ mutationFn: api.updateMember, onSuccess: refresh });
  const invite = useMutation({ mutationFn: api.invite, onSuccess: async result => { setLink(`${location.origin}/?invite=${result.token}`); await refresh(); } });
  const revoke = useMutation({ mutationFn: api.revokeInvitation, onSuccess: async () => { setLink(""); await refresh(); } });
  if (workspace.error) return <p role="alert">{workspace.error.message}<button onClick={() => void workspace.refetch()}>Réessayer</button></p>;
  if (!workspace.data) return <p role="status">Chargement de l’espace…</p>;
  const data = workspace.data;
  return <section className="approvalPanel panel"><h2>Réglages de l’espace « {data.name} »</h2><SettingsForm key={data.settings.version} workspace={data} onSaved={version => setSaved(`Réglages enregistrés (version ${version}). L’assistant les applique dès la prochaine demande.`)} />
    {saved && <p role="status">{saved}</p>}
    <ShopifyConnection />
    <h3>Membres</h3><p className="fieldHelp">Les droits prennent effet dès la prochaine demande. Le dernier administrateur reste protégé.</p>
    {data.members.map(m => <div className="documentRow" key={m.userId}><span><b>{m.email ?? "Email pas encore vérifié"}</b><small>{m.userId} · {m.active ? "Accès actif" : "Accès suspendu"}</small></span><select aria-label={`Rôle de ${m.email ?? m.userId}`} value={m.role} disabled={member.isPending} onChange={e => member.mutate({ ...m, role: e.target.value })}><Options labels={roles} /></select><button disabled={member.isPending} onClick={() => toggleAccess(m)}>{m.active ? "Suspendre" : "Réactiver"}</button></div>)}
    <h3>Inviter un membre</h3><p>Créez un lien et transmettez-le à votre collègue. Il devra se connecter avec son compte. Le lien est personnel à son porteur, valable sept jours et utilisable une seule fois.</p>
    <label htmlFor="invite-role">Rôle accordé</label><select id="invite-role" value={role} onChange={e => setRole(e.target.value)}><Options labels={roles} /></select><button disabled={invite.isPending} onClick={() => invite.mutate(role)}>Créer un lien d’invitation</button>
    {link && <><label htmlFor="invite-link">Lien à copier et transmettre en privé</label><input id="invite-link" readOnly value={link} onFocus={e => e.target.select()} /></>}
    {data.invitations.map(i => <div className="documentRow" key={i.id}><span>{roles[i.role as keyof typeof roles]}<small>{i.acceptedAt ? "Acceptée" : i.revokedAt ? "Révoquée" : new Date(i.expiresAt) < new Date() ? "Expirée" : `Valable jusqu’au ${new Date(i.expiresAt).toLocaleDateString()}`}</small></span>{!i.acceptedAt && !i.revokedAt && <button disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Révoquer</button>}</div>)}
    {[member.error, invite.error, revoke.error].filter(Boolean).map((error, i) => <p role="alert" key={i}>{error?.message}</p>)}
  </section>;
}
