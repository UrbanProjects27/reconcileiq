const collections = ['invoices', 'returns', 'priceReturns', 'advice', 'bank', 'debitNotes', 'logs', 'customerTerms'];
const emptyState = () => Object.fromEntries(collections.map(name => [name, []]));
const customerKey = name => String(name).trim().toLowerCase();
function invalid(message) { const error = new Error(message); error.status = 400; throw error; }

function validateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Workspace data must be an object.');
  const state = emptyState();
  for (const name of collections) {
    if (name === 'customerTerms' && input[name] === undefined) continue;
    if (!Array.isArray(input[name]) || input[name].length > 200000) invalid(`Invalid ${name} collection (maximum 200,000 records).`);
    state[name] = JSON.parse(JSON.stringify(input[name]));
    for (const row of state[name]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid(`Invalid ${name} record.`);
      for (const value of Object.values(row)) {
        // Legacy templates render some fields as HTML: only accept plain text.
        if (typeof value === 'string' && (value.length > 2000 || /[<>\x00-\x08\x0b-\x1f]/.test(value))) invalid(`Invalid text in ${name}. Use plain text without angle brackets.`);
        if (typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number' && !Number.isFinite(value)) invalid(`Invalid value in ${name}.`);
      }
    }
  }
  const text = (row, field, required = true) => {
    if ((required || row[field] !== undefined) && (typeof row[field] !== 'string' || required && !row[field].trim())) invalid(`A valid ${field} is required.`);
  };
  const number = (row, field, min = 0, required = true) => {
    if ((required || row[field] !== undefined) && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < min || Math.abs(row[field]) > 1e12)) invalid(`Invalid ${field}.`);
  };
  const date = row => {
    text(row, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) invalid('Invalid transaction date.');
  };
  const unique = (rows, field, normalize = x => x) => {
    const values = rows.map(row => normalize(row[field]));
    if (new Set(values).size !== values.length) invalid(`Duplicate ${field}.`);
  };
  for (const row of state.invoices) {
    text(row, 'id'); text(row, 'customer'); text(row, 'orderNumber', false); date(row); number(row, 'amount', 0.01);
    number(row, 'roundOff', -1e12, false);
    for (const field of ['qty', 'rate', 'gst']) number(row, field, 0, false);
    row.code = row.code || '—';
    if (row.roundOff === undefined) row.roundOff = 0;
  }
  unique(state.invoices, 'id');
  const invoices = new Map(state.invoices.map(row => [row.id, row]));
  for (const name of ['returns', 'priceReturns', 'advice', 'debitNotes']) {
    for (const row of state[name]) {
      text(row, 'id'); text(row, 'customer'); text(row, 'invoice', false); date(row); number(row, 'amount', 0.01);
      if (row.invoice && !invoices.has(row.invoice)) invalid(`Unknown invoice ${row.invoice}.`);
      if (row.invoice && customerKey(invoices.get(row.invoice).customer) !== customerKey(row.customer)) invalid('Customer must match the selected invoice.');
      if (name === 'advice') {
        if (!['Payment', 'TDS', 'PPV', 'PQV', 'CCOGS', 'TaxD'].includes(row.type)) invalid('Invalid payment advice type.');
        text(row, 'utr'); row.description = row.description || '';
      }
      if (name === 'debitNotes') {
        row.type = row.type || 'Unknown';
        if (!['PPV', 'PQV', 'CCOGS', 'TAXD', 'Unknown'].includes(row.type)) invalid('Invalid debit note type.');
        text(row, 'status');
      }
    }
    if (name !== 'advice') unique(state[name], 'id');
  }
  for (const row of state.bank) {
    text(row, 'ref'); date(row); number(row, 'amount', 0.01);
    if (!['matched', 'review', 'unmatched'].includes(row.status)) invalid('Invalid bank receipt status.');
  }
  for (const term of state.customerTerms) {
    text(term, 'customer'); number(term, 'creditDays');
    if (!Number.isInteger(term.creditDays) || term.creditDays > 3650) invalid('Credit days must be a whole number from 0 to 3650.');
  }
  unique(state.customerTerms, 'customer', customerKey);
  const termKeys=new Set(state.customerTerms.map(term=>customerKey(term.customer)));
  for (const invoice of state.invoices) {
    if (!termKeys.has(customerKey(invoice.customer))) {
      const days = invoice.creditDays;
      state.customerTerms.push({ customer: invoice.customer, creditDays: Number.isInteger(days) && days >= 0 && days <= 3650 ? days : 45 });
      termKeys.add(customerKey(invoice.customer));
    }
    delete invoice.creditDays;
  }
  return state;
}
module.exports = { emptyState, validateState };
