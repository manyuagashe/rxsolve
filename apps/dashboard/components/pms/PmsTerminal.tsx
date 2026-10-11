"use client";
/** The pharmacy's own dispensing system: bills the PBM switch and shows the payer's answer. No RxSolve state. */
import { useState } from "react";

const DEMO = {
  transaction: "B1",
  meta: { pbm: "PBM_PORTAL", pharmacy_id: "PH-MEADOWBROOK", state: "TN", plan: "TN Part D" },
  request: { "407-D7": "00378001801", "442-E7": 1000, "405-D5": 30, "409-D9": 14.5, "426-DQ": 18.0 },
};

const PRESCRIPTIONS = [
  { id: "queue-01", rx: "RX-7F3A-0412", patientRef: "PT-7F3A", drug: "Metformin HCl 500 mg tab", ndc: "00378001801", quantity: 1000, daysSupply: 30, submittedCost: 14.5, usualCharge: 18, serviceDate: "20261010", pbm: "PBM_PORTAL", state: "NC", plan: "NC Commercial" },
  { id: "queue-02", rx: "RX-91B2-0377", patientRef: "PT-91B2", drug: "Amlodipine 5 mg tab", ndc: "00781107210", quantity: 30, daysSupply: 30, submittedCost: 9, usualCharge: 14.5, serviceDate: "20261010" },
  { id: "queue-03", rx: "RX-5C19-0829", patientRef: "PT-S0009", drug: "Losartan Potassium 50 mg tab", ndc: "00093736598", quantity: 90, daysSupply: 30, submittedCost: 5.4, usualCharge: 12, serviceDate: "20261010", pbm: "PBM_EMAIL", state: "NC", plan: "NC Commercial" },
  { id: "queue-04", rx: "RX-3D5E-0611", patientRef: "PT-S0007", drug: "Sertraline 50 mg tab", ndc: "16714029201", quantity: 30, daysSupply: 30, submittedCost: 10.5, usualCharge: 14, serviceDate: "20261010", pbm: "PBM_EMAIL", state: "NC", plan: "NC Commercial" },
  { id: "queue-05", rx: "RX-8A21-0702", patientRef: "PT-S0008", drug: "Montelukast 10 mg tab", ndc: "60505260901", quantity: 30, daysSupply: 30, submittedCost: 13.5, usualCharge: 18, serviceDate: "20261010", pbm: "PBM_FAX", state: "NC", plan: "NC Commercial" },
] as const;

type Rx = (typeof PRESCRIPTIONS)[number] & { pbm?: string; state?: string; plan?: string };
type Fields = Record<string, unknown>;
type Answer = { rx: Rx; claimRef: string; request: Fields; response: Fields };

const money = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : v == null || v === "" ? "—" : String(v));

export function PmsTerminal() {
  const [selectedId, setSelectedId] = useState<string>(PRESCRIPTIONS[0].id);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected: Rx = PRESCRIPTIONS.find((p) => p.id === selectedId) ?? PRESCRIPTIONS[0];

  async function submit() {
    const rxNo = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
    const claimRef = `RXS-${rxNo}`;
    const request: Fields = {
      "401-D1": selected.serviceDate, "402-D2": rxNo, ...DEMO.request,
      "407-D7": selected.ndc, "442-E7": selected.quantity, "405-D5": selected.daysSupply,
      "409-D9": selected.submittedCost, "426-DQ": selected.usualCharge,
    };
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/sim/switch/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...DEMO, meta: { ...DEMO.meta, ...(selected.pbm && { pbm: selected.pbm, state: selected.state, plan: selected.plan }), patient_ref: selected.patientRef, claim_id: claimRef }, request }),
      });
      const payload = (await r.json()) as { response?: unknown; error?: unknown };
      if (!r.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Payer switch returned ${r.status}.`);
      if (!payload.response || typeof payload.response !== "object" || Array.isArray(payload.response)) throw new Error("Payer switch returned an unreadable response.");
      setAnswer({ rx: selected, claimRef, request, response: payload.response as Fields });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to reach the payer switch.");
    } finally {
      setSending(false);
    }
  }

  const rejected = answer?.response["112-AN"] === "R";

  return (
    <div className="pms-app">
      <header className="pms-top">
        <span className="pms-top__store">Meadowbrook Pharmacy · Dispensing</span>
        <span className="pms-top__meta">
          <span>Store 0412</span><span>Terminal 02</span><span>Pharmacist: J. Alvarez, RPh</span>
        </span>
      </header>

      <main className="pms-main" aria-label="Dispensing">
        <section className="pms-box" aria-labelledby="pms-queue-title">
          <h1 className="pms-box__title" id="pms-queue-title">Dispensing queue: ready to bill</h1>
          <div className="pms-box__body">
            <table className="pms-table">
              <thead>
                <tr><th scope="col">Rx number</th><th scope="col">Patient</th><th scope="col">Drug</th><th scope="col" className="pms-num">Qty</th><th scope="col" className="pms-num">Days</th><th scope="col" className="pms-num">Ingredient cost</th><th scope="col" className="pms-num">Usual charge</th></tr>
              </thead>
              <tbody>
                {PRESCRIPTIONS.map((rx) => (
                  <tr key={rx.id} aria-selected={rx.id === selected.id}>
                    <td><button type="button" className="pms-pick" onClick={() => setSelectedId(rx.id)} disabled={sending} aria-label={`Select ${rx.rx}, ${rx.drug}`}>{rx.rx}</button></td>
                    <td>{rx.patientRef}</td>
                    <td>{rx.drug}</td>
                    <td className="pms-num">{rx.quantity}</td>
                    <td className="pms-num">{rx.daysSupply}</td>
                    <td className="pms-num">{money(rx.submittedCost)}</td>
                    <td className="pms-num">{money(rx.usualCharge)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pms-actions">
              <button type="button" className="pms-btn" onClick={submit} disabled={sending}>{sending ? "Sending to payer…" : "Submit claim"}</button>
              <span>Selected: <strong>{selected.rx}</strong>, {selected.drug}</span>
            </div>
            {error && <p className="pms-error" role="alert">Claim not sent: {error}</p>}
          </div>
        </section>

        <section className="pms-box" aria-labelledby="pms-resp-title" aria-live="polite">
          <h2 className="pms-box__title" id="pms-resp-title">Payer response</h2>
          <div className="pms-box__body">
            {!answer ? <p>No claim submitted yet.</p> : (
              <>
                <p className={`pms-status ${rejected ? "pms-status--bad" : "pms-status--ok"}`}>
                  {answer.rx.rx} · {answer.rx.drug}: {rejected ? "REJECTED" : "PAID"}
                </p>
                {rejected ? (
                  <dl className="pms-resp">
                    <dt>Reject code</dt><dd>{String(answer.response["511-FB"] ?? "—")}</dd>
                    <dt>Message</dt><dd>{String(answer.response["504-F4"] ?? "Claim rejected by the payer.")}</dd>
                  </dl>
                ) : (
                  <dl className="pms-resp">
                    <dt>Total paid</dt><dd>{money(answer.response["509-F9"] ?? answer.response["506-F6"])}</dd>
                    <dt>Ingredient paid</dt><dd>{money(answer.response["506-F6"])}</dd>
                    <dt>Patient pay</dt><dd>{money(answer.response["505-F5"])}</dd>
                  </dl>
                )}
                <details className="pms-details">
                  <summary>NCPDP request and response</summary>
                  <div className="pms-details__grid">
                    <dl>
                      <dt>401-D1 Service date</dt><dd>{String(answer.request["401-D1"])}</dd>
                      <dt>402-D2 Rx reference</dt><dd>{String(answer.request["402-D2"])}</dd>
                      <dt>407-D7 Product ID</dt><dd>{String(answer.request["407-D7"])}</dd>
                      <dt>442-E7 Quantity</dt><dd>{String(answer.request["442-E7"])}</dd>
                      <dt>405-D5 Days supply</dt><dd>{String(answer.request["405-D5"])}</dd>
                      <dt>409-D9 Ingredient cost</dt><dd>{money(answer.request["409-D9"])}</dd>
                      <dt>426-DQ Usual and customary</dt><dd>{money(answer.request["426-DQ"])}</dd>
                    </dl>
                    <dl>
                      <dt>112-AN Transaction status</dt><dd>{String(answer.response["112-AN"] ?? "—")}</dd>
                      <dt>506-F6 Ingredient paid</dt><dd>{money(answer.response["506-F6"])}</dd>
                      <dt>505-F5 Patient pay</dt><dd>{money(answer.response["505-F5"])}</dd>
                      <dt>509-F9 Total paid</dt><dd>{money(answer.response["509-F9"])}</dd>
                      <dt>511-FB Reject code</dt><dd>{String(answer.response["511-FB"] ?? "—")}</dd>
                    </dl>
                  </div>
                </details>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="pms-foot">Demo: simulated pharmacy system standing in for the store&apos;s existing dispensing software.</footer>
    </div>
  );
}
