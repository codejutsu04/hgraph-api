import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/api/hgraph/transactions", async (req, res) => {
  try {
    const payerAccountId = req.query.payer_account_id || req.query.payerID;
    const decodedMemo = req.query.decoded_memo || req.query.query;
    const cryptoTransferEntityId =
      req.query.crypto_transfer_entity_id || req.query.accountFrom;
    const limit = parseInt(req.query.limit) || 10;
    const orderBy = req.query.order_by || "desc";

    if (!payerAccountId || !decodedMemo || !cryptoTransferEntityId) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required parameters: payer_account_id (or payerID), decoded_memo (or query), and crypto_transfer_entity_id (or accountFrom)",
        timestamp: new Date().toISOString(),
      });
    }

    const dynamicQuery = `
      query {
        transaction(
          where: {
            payer_account_id: { _eq: ${payerAccountId} }
            decoded_memo: { _ilike: "%${decodedMemo}%" }
            crypto_transfer: { entity_id: { _eq: ${cryptoTransferEntityId} } }
          }
          order_by: { consensus_timestamp: ${orderBy} }
          limit: ${limit}
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

    const response = await fetch(
      "https://mainnet.hedera.api.hgraph.io/v1/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: dynamicQuery }),
      }
    );

    if (!response.ok) {
      throw new Error(`HGraph API responded with status: ${response.status}`);
    }

    const result = await response.json();
    res.json(result.data);
  } catch (error) {
    console.error("Error fetching HGraph data:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
