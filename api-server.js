import express from "express";
import cors from "cors";

const app = express();
const PORT = 3009;

app.use(cors());
app.use(express.json());

// =============================================
// CONFIGURATION
// =============================================
const DRAGON_GLASS_BASE_URL = "https://explore.hbar.live/DG/";
const HGRAPH_BASE_URL = "https://mainnet.hedera.api.hgraph.io/v1/graphql";

// =============================================
// UTILITY FUNCTIONS
// =============================================

/**
 * Fix JavaScript integer precision issues for large nanosecond timestamps
 * @param {any} obj - Object to fix
 * @returns {any} Object with fixed precision
 */
function fixIntegerPrecision(obj) {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(fixIntegerPrecision);
  }

  if (typeof obj === "object") {
    const fixed = {};
    for (const [key, value] of Object.entries(obj)) {
      // Fix timestamp fields that commonly have precision issues
      if (
        (key === "consensus_timestamp" || key === "valid_start_ns") &&
        typeof value === "number"
      ) {
        // Convert scientific notation back to string representation
        if (value.toString().includes("e+")) {
          fixed[key] = Math.floor(value).toString();
        } else if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
          fixed[key] = value.toString();
        } else {
          fixed[key] = value;
        }
      } else {
        fixed[key] = fixIntegerPrecision(value);
      }
    }
    return fixed;
  }

  return obj;
}

/**
 * Convert nanosecond timestamp to ISO string with proper precision
 * @param {string|number} nanoseconds - Timestamp in nanoseconds
 * @returns {string} ISO 8601 formatted string
 */
function nanosToISOString(nanoseconds) {
  const nanosStr =
    typeof nanoseconds === "string" ? nanoseconds : nanoseconds.toString();
  const milliseconds = Math.floor(Number(nanosStr) / 1000000);
  const date = new Date(milliseconds);
  const remainingNanos = Number(nanosStr) % 1000000;

  const isoBase = date.toISOString();
  return isoBase.replace(
    /\.(\d{3})Z$/,
    `.${remainingNanos.toString().padStart(6, "0")}Z`
  );
}

/**
 * Clean transaction hash (remove \x prefix if present)
 * @param {string} hash - Transaction hash
 * @returns {string} Cleaned hash
 */
function cleanTransactionHash(hash) {
  return hash.startsWith("\\x") ? hash.slice(2) : hash;
}

// =============================================
// DATA TRANSFORMATION FUNCTIONS
// =============================================

/**
 * Transform HGraph data to Dragon Glass format
 * @param {Object} hgraphData - Raw HGraph response
 * @returns {Object} Transformed data in Dragon Glass format
 */
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
    // Use string-based timestamp conversion to preserve precision
    const consensusTime = nanosToISOString(tx.consensus_timestamp);
    const startTime = nanosToISOString(tx.valid_start_ns);

    // Clean transaction hash
    const transactionHash = cleanTransactionHash(tx.transaction_hash);

    // Create readable transaction ID
    const validStartSecs = Math.floor(
      Number(tx.valid_start_ns.toString()) / 1000000000
    );
    const validStartNanos = Number(tx.valid_start_ns.toString()) % 1000000000;
    const readableTransactionID = `0.0.${tx.payer_account_id}@${validStartSecs}.${validStartNanos}`;

    // Create full transaction ID
    const transactionID = `${String(tx.payer_account_id).padStart(8, "0")}${
      tx.valid_start_ns
    }`;

    // Transform transfers to Dragon Glass format
    const transfers = (tx.crypto_transfer || []).map((transfer) => ({
      accountID: `0.0.${transfer.entity_id}`,
      amount: transfer.amount,
    }));

    // Calculate fees
    const transactionFee = tx.charged_tx_fee;
    const nodeFees =
      transfers.find(
        (t) => t.accountID === `0.0.${tx.node_account_id}` && t.amount > 0
      )?.amount || 0;
    const networkFees = transactionFee - nodeFees;

    // Calculate total amount
    const amount = transactionFee;

    return {
      transactionID,
      readableTransactionID,
      transactionHash,
      payerID: `0.0.${tx.payer_account_id}`,
      startTime,
      nodeID: `0.0.${tx.node_account_id}`,
      consensusTime,
      transactionFee,
      nodeFees,
      networkFees,
      transfers,
      status: tx.result === 22 ? "SUCCESS" : "FAILED",
      amount,
      memo: tx.decoded_memo || "",
      transactionType: "CRYPTO_TRANSFER",
      knownLabel: "CryptoTransfer",
      typeLabel: "Crypto Transfer",
      serviceType: "CRYPTO",
      source: "hgraphio",
    };
  });

  // Build facets
  const facets = {
    transactionTypes: { CRYPTO_TRANSFER: transformedData.length },
    payerID: {},
    serviceTypes: { CRYPTO: transformedData.length },
  };

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

// =============================================
// API CLIENT FUNCTIONS
// =============================================

/**
 * Call Dragon Glass API
 * @param {string} payerID - Payer account ID
 * @param {string} query - Search query
 * @param {string} accountFrom - Account filter
 * @returns {Object} API response
 */
async function callDragonGlassAPI(payerID, query, accountFrom) {
  try {
    const url = `${DRAGON_GLASS_BASE_URL}?cacheSeconds=30&endpoint=transactions&payerID=0.0.${payerID}&accountFrom=0.0.${accountFrom}&query=${encodeURIComponent(
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
    console.error("Dragon Glass API Error:", error);
    return {
      success: false,
      error: error.message,
      source: "dragonglass",
      data: { size: 0, totalCount: 0, data: [], facets: {}, mapping: null },
    };
  }
}

/**
 * Call HGraph API
 * @param {string} payerID - Payer account ID
 * @param {string} query - Search query
 * @param {string} accountFrom - Account filter
 * @returns {Object} API response
 */
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

    const response = await fetch(HGRAPH_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: dynamicQuery }),
    });

    if (!response.ok) {
      throw new Error(`HGraph API responded with status: ${response.status}`);
    }

    const result = await response.json();

    // Apply precision fix to the result
    const fixedResult = fixIntegerPrecision(result);

    return {
      success: true,
      data: fixedResult.data,
      source: "hgraphio",
    };
  } catch (error) {
    console.error("HGraph API Error:", error);
    return {
      success: false,
      error: error.message,
      source: "hgraphio",
      data: { transaction: [] },
    };
  }
}

// =============================================
// COMPARISON FUNCTIONS
// =============================================

/**
 * Create canonical hash array for comparison
 * @param {Object} data - API response data
 * @param {string} source - Data source ('dragonglass' or 'hgraphio')
 * @returns {Array} Array of transaction hashes
 */
function createCanonicalHashArray(data, source) {
  if (source === "dragonglass") {
    return data.data ? data.data.map((tx) => tx.transactionHash).sort() : [];
  } else if (source === "hgraphio") {
    return data.transaction
      ? data.transaction
          .map((tx) => cleanTransactionHash(tx.transaction_hash))
          .sort()
      : [];
  }
  return [];
}

/**
 * Compare transaction arrays and determine discrepancies
 * @param {Array} dragonGlassHashes - Dragon Glass transaction hashes
 * @param {Array} hgraphHashes - HGraph transaction hashes
 * @returns {Object} Comparison result
 */
function compareAndGetStatus(dragonGlassHashes, hgraphHashes) {
  const dgSet = new Set(dragonGlassHashes);
  const hgSet = new Set(hgraphHashes);

  const missingInDragonGlass = hgraphHashes.filter((hash) => !dgSet.has(hash));
  const missingInHGraph = dragonGlassHashes.filter((hash) => !hgSet.has(hash));

  if (missingInDragonGlass.length === 0 && missingInHGraph.length === 0) {
    return {
      status: "match",
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

// =============================================
// API ENDPOINTS
// =============================================

/**
 * Health check endpoint
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    endpoints: [
      "/api/transactions/compare",
      "/api/hgraph/transactions",
      "/api/hgraph/transactions/dg-format",
    ],
  });
});

app.get("/api/hgraph/transactions", async (req, res) => {
  try {
    const payerID = req.query.payer_account_id || req.query.payerID;
    const query = req.query.decoded_memo || req.query.query;
    const accountFrom =
      req.query.crypto_transfer_entity_id || req.query.accountFrom;

    if (!payerID || !query || !accountFrom) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required parameters: payerID, query, and accountFrom are required",
        timestamp: new Date().toISOString(),
      });
    }

    const result = await callHGraphAPI(payerID, query, accountFrom);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
    }

    // Return the precision-fixed data
    res.json({
      ...result.data,
      metadata: {
        source: "hgraphio",
        precision_fixed: true,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error in HGraph endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

//  NEW: HGraph transactions in Dragon Glass format

app.get("/api/hgraph/transactions/dg-format", async (req, res) => {
  try {
    const { payerID, query, accountFrom } = req.query;

    if (!payerID || !query || !accountFrom) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: payerID, query, and accountFrom",
        timestamp: new Date().toISOString(),
      });
    }

    const hgraphResult = await callHGraphAPI(payerID, query, accountFrom);

    if (!hgraphResult.success) {
      return res.status(500).json({
        success: false,
        error: hgraphResult.error,
        timestamp: new Date().toISOString(),
      });
    }

    const transformedData = transformHGraphToDragonGlass(hgraphResult.data);

    res.json({
      ...transformedData,
      metadata: {
        source: "hgraphio_converted_to_dragonglass_format",
        original_source: "hgraphio",
        transformation_applied: true,
        precision_fixed: true,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error in HGraph DG format endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * ENHANCED: Better error handling and cleaner response structure
 */
app.get("/api/transactions/compare", async (req, res) => {
  try {
    const { payerID, query, accountFrom } = req.query;

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

    // Prepare response
    const response = {
      // Primary data from Dragon Glass (as requested)
      size: dragonGlassResult.data.size || 0,
      totalCount: dragonGlassResult.data.totalCount || 0,
      data: dragonGlassResult.data.data || [],
      facets: dragonGlassResult.data.facets || {},
      mapping: dragonGlassResult.data.mapping || null,

      // Enhanced metadata
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

    // Include additional HGraph data when there are discrepancies
    if (
      comparisonResult.status === "discrepancy_detected" &&
      comparisonResult.discrepancies
    ) {
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

/**
 * Dashboard status endpoint for labs1.kpay.uk integration
 */
app.get("/api/dashboard/status", async (req, res) => {
  try {
    // Get recent comparison for dashboard
    const [dragonGlassResult, hgraphResult] = await Promise.all([
      callDragonGlassAPI("26027", "kpay.live", "657983"),
      callHGraphAPI("26027", "kpay.live", "657983"),
    ]);

    const dragonGlassHashes = createCanonicalHashArray(
      dragonGlassResult.data,
      "dragonglass"
    );
    const hgraphHashes = createCanonicalHashArray(
      hgraphResult.data,
      "hgraphio"
    );
    const comparisonResult = compareAndGetStatus(
      dragonGlassHashes,
      hgraphHashes
    );

    const dashboardData = {
      timestamp: new Date().toISOString(),
      sources: {
        dragonglass: {
          status: dragonGlassResult.success ? "online" : "offline",
          count: dragonGlassResult.data.data?.length || 0,
          last_checked: new Date().toISOString(),
        },
        hgraphio: {
          status: hgraphResult.success ? "online" : "offline",
          count: hgraphResult.data.transaction?.length || 0,
          last_checked: new Date().toISOString(),
        },
      },
      discrepancies: comparisonResult.discrepancies,
      overall_status: comparisonResult.status,
      bug_detected:
        comparisonResult.status === "discrepancy_detected" &&
        comparisonResult.discrepancies?.missing_in_dragonglass?.length > 0,

      // Add dashboard link for labs1.kpay.uk button
      dashboard_url: `${req.protocol}://${req.get("host")}/dashboard`,
      api_documentation_url: `${req.protocol}://${req.get("host")}/dashboard`,

      // Quick test URLs for the three main endpoints
      test_urls: {
        compare: `${req.protocol}://${req.get(
          "host"
        )}/api/transactions/compare?payerID=26027&query=kpay.live&accountFrom=657983`,
        hgraph_data: `${req.protocol}://${req.get(
          "host"
        )}/api/hgraph/transactions?payerID=26027&query=kpay.live&accountFrom=657983`,
        hgraph_dg_format_data: `${req.protocol}://${req.get(
          "host"
        )}/api/hgraph/transactions/dg-format?payerID=26027&query=kpay.live&accountFrom=657983`,
      },
    };

    res.json(dashboardData);
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      error: "Dashboard error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development"
        ? error.message
        : "Something went wrong",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
    message: `Route ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 KPay Transaction API server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(
    `🔍 Compare: http://localhost:${PORT}/api/transactions/compare?payerID=26027&query=kpay.live&accountFrom=657983`
  );
  console.log(
    `🌐 HGraph (fixed): http://localhost:${PORT}/api/hgraph/transactions?payerID=26027&query=kpay.live&accountFrom=657983`
  );
  console.log(
    `📋 HGraph (DG format): http://localhost:${PORT}/api/hgraph/transactions/dg-format?payerID=26027&query=kpay.live&accountFrom=657983`
  );
  console.log(`📈 Dashboard: http://localhost:${PORT}/api/dashboard/status`);
});

export default app;
