# KPay Transaction Comparison API

API to compare Hedera blockchain transactions between Dragonglass and HGraphIO, detecting discrepancies and confirming the Dragonglass `accountFrom` filter bug.

## 🐛 Bug Confirmed

Dragonglass misses transactions with small transfer amounts (~35K tinybars) to filtered accounts. HGraph returns 10 transactions, DG only returns 8.

## 🚀 Quick Start

```bash
npm install
npm start
```

## 📡 Key Endpoints

- `GET /api/transactions/compare` - Compare DG vs HGraph data
- `GET /api/hgraph/transactions` - HGraph data
- `GET /api/hgraph/transactions/dg-format` - All HGraph data in DG format
- `GET /dashboard` -
