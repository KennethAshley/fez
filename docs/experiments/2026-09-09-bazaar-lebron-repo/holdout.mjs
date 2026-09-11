// Buyer-side checks withheld from the worker repository.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { invoiceBalance: balance } = await import(pathToFileURL(process.argv[2]));
assert.equal(balance(12500, [{ref:"P1",cents:5000},{ref:"R1",cents:-1000},{ref:"P1",cents:5000}]),8500);
assert.equal(balance(0,[{ref:"R1",cents:-100},{ref:"R1",cents:-100}]),100);
assert.equal(balance(1000,[{ref:"A",cents:300},{ref:"B",cents:300}]),400);
assert.throws(()=>balance(1000,[{ref:"A",cents:300},{ref:"A",cents:-300}]));
assert.throws(()=>balance(1000,[{ref:"A",cents:300},{ref:"A",cents:NaN}]),TypeError);
assert.equal(balance(1000,[{ref:"__proto__",cents:100},{ref:"toString",cents:200},{ref:"__proto__",cents:100}]),700);
const input=Object.freeze([Object.freeze({ref:"A",cents:100}),Object.freeze({ref:"A",cents:100})]);
assert.equal(balance(500,input),400);
assert.equal(balance(0,[]),0);
assert.equal(balance(500,[{ref:"A",cents:500}]),0);
assert.equal(balance(200,[{ref:"A",cents:300},{ref:"A",cents:300}]),-100);
console.log("PASS: 10 independent buyer checks, including nonadjacent duplicates, repeated refunds, conflicting references, immutable inputs, and prototype-like references.");
