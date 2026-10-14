import {
	type CompiledQuery,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type Kysely,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import type { Db } from "../db";

type InArgs = Parameters<Db["execute"]>[1];

// Lets better-auth's Kysely adapter run on the libSQL client src/db hands in;
// better-auth detects no libSQL client on its own. No interactive
// transactions: better-auth leaves `transaction` off for a bare dialect.
export function libsqlDialect(db: Db): Dialect {
	const connection: DatabaseConnection = {
		async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
			const result = await db.execute(query.sql, query.parameters as InArgs);
			return {
				rows: result.rows.map(
					(row) =>
						Object.fromEntries(
							result.columns.map((column, i) => [column, row[i]]),
						) as R,
				),
				numAffectedRows: BigInt(result.rowsAffected),
				insertId: result.lastInsertRowid,
			};
		},
		// biome-ignore lint/correctness/useYield: unsupported, so it throws before yielding
		async *streamQuery() {
			throw new Error("libsqlDialect does not stream");
		},
	};
	const noTransactions = () =>
		Promise.reject(new Error("libsqlDialect has no interactive transactions"));
	const driver: Driver = {
		init: async () => {},
		acquireConnection: async () => connection,
		beginTransaction: noTransactions,
		commitTransaction: noTransactions,
		rollbackTransaction: noTransactions,
		releaseConnection: async () => {},
		destroy: async () => {},
	};
	return {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => driver,
		createIntrospector: (kysely: Kysely<unknown>) =>
			new SqliteIntrospector(kysely),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	};
}
