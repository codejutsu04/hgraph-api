// Simple HGraph GraphQL Query - Just the basics

const query = `
  query {
    transaction(
      where: {
        payer_account_id: { _eq: 26027 }
        decoded_memo: { _ilike: "%kpay.live%" }
        crypto_transfer: { entity_id: { _eq: 657983 } }
      }
      order_by: { consensus_timestamp: desc }
      limit: 10
    ) {
      consensus_timestamp
      payer_account_id
      result
      charged_tx_fee
      decoded_memo
      type
      transaction_hash
      node_account_id
      valid_start_ns
      max_fee
      valid_duration_seconds
      crypto_transfer {
        entity_id
        amount
      }
      token_transfer {
        token_id
        account_id
        amount
      }
    }
  }
`;

async function callHGraph() {
  const response = await fetch(
    "https://mainnet.hedera.api.hgraph.io/v1/graphql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );

  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
}

callHGraph();
