// One answer contract for discovery metadata, server instructions and results.
export const OEREB_ANSWER_RULES =
  "Always work from get_oereb_extract JSON first; it is the default fast path. " +
  "When answering about restrictions, list ALL returned restrictions, legal provisions, legal bases, hints/disclaimers and their references, with full supplied titles/identifiers and every full source URL; do not replace a complete list with selected examples, ellipses or hidden link labels. " +
  "Only narrow the substantive topic when the user explicitly requests that particular right/topic, and state that scope; retain applicable disclaimers and the coverage warning. Do not claim to have read linked legal texts that were not retrieved. " +
  "The JSON can already contain cantonal themes; do not say it contains federal data only. It does not establish complete coverage of the cantonal additional information in Annex A. Explicitly disclose that further cantonal requirements/restrictions may exist without claiming they apply to this property or that every additional planning item is a binding restriction. " +
  "Do not fetch, offer a download URL for, or call get_oereb_pdf_link unless the user explicitly requests a PDF. " +
  "Preserve supplied URLs exactly; never append tracking parameters such as utm_source. Show legal URLs in literal code text alongside their full supplied titles. For a requested PDF, show pdfUrl verbatim in a fenced text code block for copying rather than a Markdown/autolink that a client may rewrite.";

export const CANTONAL_SUPPLEMENT_NOTICE =
  "Das JSON kann bereits kantonale Themen enthalten. Die Vollständigkeit der kantonalen Zusatzinformationen des Anhangs A ist damit jedoch nicht nachgewiesen. Es können weitere kantonale Vorgaben oder Einschränkungen bestehen; deren Betroffenheit für dieses Grundstück wurde hier nicht geprüft. Zusatzinformationen sind nicht pauschal rechtsverbindliche Eigentumsbeschränkungen. Ein PDF wird nur auf ausdrückliche Anfrage bereitgestellt.";
