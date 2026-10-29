//! Debug: dump the core `Block` my RPC conversion produces for a height
//! (env: HOPPER_RPC_URL / HOPPER_RPC_COOKIE, arg: height).
use hopper_indexer_api::rpc::BitcoinRpc;
use hopper_indexer_api::sync::BlockSource;
use hopper_indexer_api::wire::parse_hash;

fn main() {
    let height: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(106);
    let mut rpc = BitcoinRpc::from_env().unwrap();
    let hex = rpc
        .call("getblockhash", serde_json::json!([height]))
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let hash = parse_hash(&hex).unwrap();
    let block = BlockSource::block(&mut rpc, hash).unwrap();
    println!("height {} hash {:?}", block.height, block.hash);
    for (i, tx) in block.txs.iter().enumerate() {
        println!("tx[{i}] {:?}", tx.txid);
        for (j, input) in tx.inputs.iter().enumerate() {
            println!(
                "  in[{j}] prevout {:?}:{} value {}",
                input.prevout.txid, input.prevout.vout, input.value
            );
        }
        for (j, out) in tx.outputs.iter().enumerate() {
            println!(
                "  out[{j}] value {} op_return {:?}",
                out.value, out.op_return
            );
        }
    }
}
