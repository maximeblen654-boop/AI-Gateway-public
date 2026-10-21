package mediaworkbench

// MediaRetailVersion is the server-owned sale-only Studio contract. Historical
// cost fields remain decodable, but are never an input to a new transaction.
const MediaRetailVersion = 2

func normalizeProductCost(p *Product) {
	p.CostVersion = MediaRetailVersion
	p.CostRules = nil
}
