import express from "express";
import cors from "cors";

const app = express();
const PORT = 3009;

app.use(cors());
app.use(express.json());

// Helper function to transform HGraph data to Dragon Glass format
function transformHGraphToDragonGlass(hgraphData) {
  if (!hgraphData.transaction || !Array.isArray(hgraphData.transaction)) {
    return {
      size: 0,
      totalCount: 0,
      data: [],
      facets: {
        transactionTypes: {},
        payerID: {},
        serviceTypes: {},
      },
      mapping: null,
    };
  }

  const transactions = hgraphData.transaction;
  const transformedData = transactions.map((tx) => {
    // Convert nanosecond timestamp to readable format
    const consensusTimeMs = Math.floor(tx.consensus_timestamp / 1000000);
    const consensusTime = new Date(consensusTimeMs).toISOString();

    const validStartMs = Math.floor(tx.valid_start_ns / 1000000);
    const startTime = new Date(validStartMs).toISOString();

    // Convert transaction hash from hex string to readable format
    const transactionHash = tx.transaction_hash.startsWith("\\x")
      ? tx.transaction_hash.slice(2)
      : tx.transaction_hash;

    // Create readable transaction ID
    const readableTransactionID = `0.0.${tx.payer_account_id}@${Math.floor(
      tx.valid_start_ns / 1000000000
    )}.${tx.valid_start_ns % 1000000000}`;

    // Transform transfers to Dragon Glass format
    const transfers = tx.crypto_transfer.map((transfer) => ({
      accountID: `0.0.${transfer.entity_id}`,
      amount: transfer.amount,
    }));

    // Calculate total amount (sum of positive transfers)
    const amount = transfers
      .filter((t) => t.amount > 0)
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    // Calculate fees
    const transactionFee = tx.charged_tx_fee;
    const nodeFees =
      transfers.find((t) => t.accountID === `0.0.${tx.node_account_id}`)
        ?.amount || 0;
    const networkFees = transactionFee - Math.abs(nodeFees);

    return {
      transactionID: `00${tx.payer_account_id}${tx.valid_start_ns}`,
      readableTransactionID,
      transactionHash,
      payerID: `0.0.${tx.payer_account_id}`,
      startTime,
      nodeID: `0.0.${tx.node_account_id}`,
      consensusTime,
      transactionFee,
      nodeFees: Math.abs(nodeFees),
      networkFees,
      transfers,
      status: tx.result === 22 ? "SUCCESS" : "FAILED", // 22 is SUCCESS in Hedera
      amount,
      memo: tx.decoded_memo || "",
      transactionType: "CRYPTO_TRANSFER",
      knownLabel: "CryptoTransfer",
      typeLabel: "Crypto Transfer",
      serviceType: "CRYPTO",
    };
  });

  // Build facets
  const facets = {
    transactionTypes: { CRYPTO_TRANSFER: transformedData.length },
    payerID: {},
    serviceTypes: { CRYPTO: transformedData.length },
  };

  // Count payer IDs
  transformedData.forEach((tx) => {
    facets.payerID[tx.payerID] = (facets.payerID[tx.payerID] || 0) + 1;
  });

  return {
    size: transformedData.length,
    totalCount: transformedData.length,
    data: transformedData,
    facets,
    mapping: null,
  };
}

// Helper function to call Dragon Glass API
async function callDragonGlassAPI(payerID, query, accountFrom) {
  try {
    const url = `https://explore.hbar.live/DG/?cacheSeconds=30&endpoint=transactions&payerID=0.0.${payerID}&accountFrom=0.0.${accountFrom}&query=${encodeURIComponent(
      query
    )}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Dragon Glass API responded with status: ${response.status}`
      );
    }

    const data = await response.json();
    return {
      success: true,
      data,
      source: "dragonglass",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      source: "dragonglass",
      data: { size: 0, totalCount: 0, data: [], facets: {}, mapping: null },
    };
  }
}

// Helper function to call HGraph API (internal)
async function callHGraphAPI(payerID, query, accountFrom) {
  try {
    const dynamicQuery = `
      query {
        transaction(
          where: {
            payer_account_id: { _eq: ${payerID} }
            decoded_memo: { _ilike: "%${query}%" }
            crypto_transfer: { entity_id: { _eq: ${accountFrom} } }
          }
          order_by: { consensus_timestamp: desc }
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
    return {
      success: true,
      data: result.data,
      source: "hgraphio",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      source: "hgraphio",
      data: { transaction: [] },
    };
  }
}

// Helper function to create canonical hash array for comparison
function createCanonicalHashArray(data, source) {
  if (source === "dragonglass") {
    return data.data ? data.data.map((tx) => tx.transactionHash).sort() : [];
  } else if (source === "hgraphio") {
    return data.transaction
      ? data.transaction
          .map((tx) => {
            const hash = tx.transaction_hash.startsWith("\\x")
              ? tx.transaction_hash.slice(2)
              : tx.transaction_hash;
            return hash;
          })
          .sort()
      : [];
  }
  return [];
}

// Helper function to compare arrays and determine status
function compareAndGetStatus(dragonGlassHashes, hgraphHashes) {
  const dgSet = new Set(dragonGlassHashes);
  const hgSet = new Set(hgraphHashes);

  const missingInDragonGlass = hgraphHashes.filter((hash) => !dgSet.has(hash));
  const missingInHGraph = dragonGlassHashes.filter((hash) => !hgSet.has(hash));

  if (missingInDragonGlass.length === 0 && missingInHGraph.length === 0) {
    return {
      status: "ok",
      discrepancies: null,
    };
  }

  return {
    status: "discrepancy_detected",
    discrepancies: {
      missing_in_dragonglass: missingInDragonGlass,
      missing_in_hgraph: missingInHGraph,
      dragonglass_count: dragonGlassHashes.length,
      hgraph_count: hgraphHashes.length,
    },
  };
}

// Original HGraph endpoint (keep as-is)
app.get("/api/hgraph/transactions", async (req, res) => {
  try {
    const payerAccountId = req.query.payer_account_id || req.query.payerID;
    const decodedMemo = req.query.decoded_memo || req.query.query;
    const cryptoTransferEntityId =
      req.query.crypto_transfer_entity_id || req.query.accountFrom;
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

// NEW WRAPPER ENDPOINT
app.get("/api/transactions/compare", async (req, res) => {
  try {
    const payerID = req.query.payerID;
    const query = req.query.query;
    const accountFrom = req.query.accountFrom;

    if (!payerID || !query || !accountFrom) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: payerID, query, and accountFrom",
        timestamp: new Date().toISOString(),
      });
    }

    // Call both APIs in parallel
    const [dragonGlassResult, hgraphResult] = await Promise.all([
      callDragonGlassAPI(payerID, query, accountFrom),
      callHGraphAPI(payerID, query, accountFrom),
    ]);

    // Transform HGraph data to Dragon Glass format
    const transformedHGraphData = transformHGraphToDragonGlass(
      hgraphResult.data
    );

    // Create canonical hash arrays for comparison
    const dragonGlassHashes = createCanonicalHashArray(
      dragonGlassResult.data,
      "dragonglass"
    );
    const hgraphHashes = createCanonicalHashArray(
      hgraphResult.data,
      "hgraphio"
    );

    // Compare and get status
    const comparisonResult = compareAndGetStatus(
      dragonGlassHashes,
      hgraphHashes
    );

    // Prepare response with metadata
    const response = {
      // Use Dragon Glass data as primary (as requested)
      ...dragonGlassResult.data,

      // Add metadata for each transaction indicating source
      data: dragonGlassResult.data.data
        ? dragonGlassResult.data.data.map((tx) => ({
            ...tx,
            source: "dragonglass",
          }))
        : [],

      // Add comparison metadata
      metadata: {
        comparison: {
          status: comparisonResult.status,
          sources_called: ["dragonglass", "hgraphio"],
          dragonglass_success: dragonGlassResult.success,
          hgraphio_success: hgraphResult.success,
          discrepancies: comparisonResult.discrepancies,
          canonical_hashes: {
            dragonglass: dragonGlassHashes,
            hgraphio: hgraphHashes,
          },
        },
        timestamp: new Date().toISOString(),
      },
    };

    // If there are discrepancies, include additional data from HGraph
    if (comparisonResult.status !== "ok" && comparisonResult.discrepancies) {
      response.metadata.additional_hgraph_data = transformedHGraphData;
    }

    res.json(response);
  } catch (error) {
    console.error("Error in comparison endpoint:", error);
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
  console.log(
    `Raw HGraph API: http://localhost:${PORT}/api/hgraph/transactions`
  );
  console.log(
    `Comparison wrapper: http://localhost:${PORT}/api/transactions/compare`
  );
});

export default app;
