import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { orderLabel } from "./format";

/** Tickets created from the chat, for the human follow-up. `focus` highlights one just created. */
export function Tickets({ userId, focus }: { userId: string; focus: string | null }) {
  const cache = useQueryClient();
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const tickets = useQuery({ queryKey: ["tickets", filter], queryFn: () => api.tickets(filter) });
  const resolve = useMutation({ mutationFn: api.resolveTicket, onSuccess: () => cache.invalidateQueries({ queryKey: ["tickets"] }) });
  return <section className="approvalPanel panel">
    <h2>Tickets</h2>
    <div className="approvalActions" role="group" aria-label="Filtrer les tickets">
      <button aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Ouverts</button>
      <button aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")}>Résolus</button>
    </div>
    {tickets.error && <p role="alert">{tickets.error.message}</p>}
    {tickets.data?.length === 0 && <p>{filter === "open" ? "Aucun ticket ouvert." : "Aucun ticket résolu."}</p>}
    {tickets.data?.map(ticket => <article className={ticket.id === focus ? "documentRow highlighted" : "documentRow"} key={ticket.id} aria-current={ticket.id === focus ? "true" : undefined}>
      <span>
        <b>{ticket.subject}</b>
        <small>{ticket.id}{ticket.orderId && ` · ${orderLabel(ticket.orderId, ticket.orderReference)}`} · créé par {ticket.createdBy === userId ? "vous" : ticket.createdBy}</small>
        <p className="documentText">{ticket.body}</p>
        {ticket.resolvedBy && <small>Résolu par {ticket.resolvedBy === userId ? "vous" : ticket.resolvedBy}</small>}
      </span>
      {ticket.status === "open" && <button disabled={resolve.isPending} onClick={() => resolve.mutate(ticket.id)}>Marquer résolu</button>}
    </article>)}
    {resolve.error && <p role="alert">{resolve.error.message}</p>}
  </section>;
}
