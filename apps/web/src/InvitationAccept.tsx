import { useMutation } from "@tanstack/react-query";
import { api } from "./api";
export function InvitationAccept({ token }: { token: string }) {
  const accept = useMutation({ mutationFn: api.acceptInvitation, onSuccess: () => { sessionStorage.removeItem("helio-invitation"); location.replace("/"); } });
  return <main className="approvalPanel panel"><h1>Rejoindre votre équipe sur Helio</h1><p>Acceptez cette invitation uniquement si elle vous a été transmise par votre entreprise.</p><button disabled={accept.isPending} onClick={() => accept.mutate(token)}>Accepter l’invitation</button><button onClick={() => { sessionStorage.removeItem("helio-invitation"); location.replace("/"); }}>Annuler</button>{accept.error && <p role="alert">{accept.error.message}</p>}</main>;
}
