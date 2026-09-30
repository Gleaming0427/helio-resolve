import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type ApprovalView } from "./api";
import { formatMoney, orderLabel } from "./format";

const statuses: Record<ApprovalView["status"], string> = { pending: "À approuver", approved: "Approuvée, à exécuter", rejected: "Refusée", executed: "Remboursée" };

/** The manager's queue. `focus` opens a proposal created from the chat. */
export function Approvals({ userId, focus }: { userId: string; focus: string | null }) {
  const cache = useQueryClient();
  const [filter, setFilter] = useState<"open" | "closed">("open");
  const [selected, setSelected] = useState<string | null>(focus);
  const [notice, setNotice] = useState("");
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  const list = useQuery({ queryKey: ["approvals", filter], queryFn: () => api.approvals(filter) });
  const detail = useQuery({ queryKey: ["approval", selected], queryFn: () => api.getApproval(selected!), enabled: !!selected });
  const refresh = async (message: string) => {
    setNotice(message);
    await cache.invalidateQueries({ queryKey: ["approvals"] });
    await cache.invalidateQueries({ queryKey: ["approval", selected] });
  };
  const approve = useMutation({ mutationFn: api.approve, onSuccess: () => refresh("Proposition approuvée. Vous pouvez lancer le remboursement.") });
  const reject = useMutation({ mutationFn: api.reject, onSuccess: () => refresh("Proposition refusée. La commande peut faire l’objet d’une nouvelle demande.") });
  const execute = useMutation({ mutationFn: api.execute, onSuccess: () => refresh("Remboursement exécuté dans la boutique."), onSettled: () => cache.invalidateQueries({ queryKey: ["approval", selected] }) });
  const busy = approve.isPending || reject.isPending || execute.isPending;
  const approval = detail.data;
  const ownProposal = approval?.proposedBy === userId;
  const error = [approve.error, reject.error, execute.error, detail.error].find(Boolean);
  return <section className="approvalPanel panel">
    <h2>Propositions de remboursement</h2>
    <div className="approvalActions" role="group" aria-label="Filtrer les propositions">
      <button aria-pressed={filter === "open"} onClick={() => setFilter("open")}>À traiter</button>
      <button aria-pressed={filter === "closed"} onClick={() => setFilter("closed")}>Traitées</button>
    </div>
    {list.error && <p role="alert">{list.error.message}</p>}
    {list.data?.length === 0 && <p>{filter === "open" ? "Aucune proposition en attente." : "Aucune proposition traitée."}</p>}
    {list.data?.map(item => <div className="documentRow" key={item.id}>
      <span><b>{orderLabel(item.orderId, item.order?.reference)} ·{item.order ? formatMoney(item.order.totalCents, item.order.currency) : "montant inconnu"}</b><small>{statuses[item.status]} · {item.reason}</small></span>
      <button onClick={() => { setSelected(item.id); setNotice(""); }}>Ouvrir</button>
    </div>)}
    {approval && <div className="approvalCard">
      <dl>
        <dt>Commande</dt><dd>{orderLabel(approval.orderId, approval.order?.reference)}{approval.order && ` · ${formatMoney(approval.order.totalCents, approval.order.currency)}`}</dd>
        <dt>Statut</dt><dd><span className="statusBadge">{statuses[approval.status]}</span></dd>
        <dt>Motif</dt><dd>{approval.reason}</dd>
        <dt>Proposée par</dt><dd>{approval.proposedBy === userId ? "vous" : approval.proposedBy ?? "inconnu"}</dd>
        {approval.execution && <><dt>Exécution</dt><dd>{approval.execution.status === "refunded" ? `Remboursée (${approval.execution.providerRefundId})`
          : approval.execution.status === "failed" ? `Refusée par la boutique : ${approval.execution.failureReason}. Traitez ce remboursement directement dans Shopify.`
          : "Résultat en attente : relancez l’exécution, elle ne créera pas de doublon."}</dd></>}
      </dl>
      {ownProposal && approval.status === "pending" && <p className="fieldHelp">Vous avez fait cette proposition : une autre personne doit l’approuver.</p>}
      <div className="approvalActions">
        <button disabled={busy || approval.status !== "pending" || ownProposal} onClick={() => approve.mutate(approval.id)}>Approuver</button>
        <button disabled={busy || approval.status !== "pending"} onClick={() => { if (confirm("Refuser cette proposition ? La commande pourra faire l’objet d’une nouvelle demande.")) reject.mutate(approval.id); }}>Refuser</button>
        <button disabled={busy || approval.status !== "approved" || approval.execution?.status === "failed"} onClick={() => execute.mutate(approval.id)}>
          {approval.execution?.status === "pending" ? "Reprendre le remboursement" : "Exécuter le remboursement"}
        </button>
      </div>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error.message}</p>}
  </section>;
}
