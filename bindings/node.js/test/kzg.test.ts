import {randomBytes} from "crypto";
import {readFileSync, existsSync} from "fs";
import {resolve} from "path";
import {globSync} from "glob";

const yaml = require("js-yaml");

interface TestMeta<I extends Record<string, any>, O extends boolean | string | string[] | Record<string, any>> {
  input: I;
  output: O;
}

import kzg from "../lib/kzg";
import type {ProofResult} from "../lib/kzg";
const {
  // EIP-4844
  loadTrustedSetup,
  blobToKzgCommitment,
  computeKzgProof,
  computeBlobKzgProof,
  verifyKzgProof,
  verifyBlobKzgProof,
  verifyBlobKzgProofBatch,
  BYTES_PER_BLOB,
  BYTES_PER_COMMITMENT,
  BYTES_PER_PROOF,

  // EIP-7594
  computeCells,
  computeCellsAndKzgProofs,
  verifyCellKzgProofBatch,
  recoverCellsAndKzgProofs,
} = kzg;

// not exported by types, only exported for testing purposes
const getTrustedSetupFilepath = (kzg as any).getTrustedSetupFilepath as (filePath?: string) => string;
const DEFAULT_TRUSTED_SETUP_PATH = (kzg as any).DEFAULT_TRUSTED_SETUP_PATH as string;

const TEST_SETUP_FILE_PATH_JSON = resolve(__dirname, "__fixtures__", "trusted_setup.json");
const TEST_SETUP_FILE_PATH_TXT = resolve(__dirname, "__fixtures__", "trusted_setup.txt");

const MAX_TOP_BYTE = 114;

const BLOB_TO_KZG_COMMITMENT_TESTS = "../../tests/blob_to_kzg_commitment/*/*/data.yaml";
const COMPUTE_KZG_PROOF_TESTS = "../../tests/compute_kzg_proof/*/*/data.yaml";
const COMPUTE_BLOB_KZG_PROOF_TESTS = "../../tests/compute_blob_kzg_proof/*/*/data.yaml";
const VERIFY_KZG_PROOF_TESTS = "../../tests/verify_kzg_proof/*/*/data.yaml";
const VERIFY_BLOB_KZG_PROOF_TESTS = "../../tests/verify_blob_kzg_proof/*/*/data.yaml";
const VERIFY_BLOB_KZG_PROOF_BATCH_TESTS = "../../tests/verify_blob_kzg_proof_batch/*/*/data.yaml";

const COMPUTE_CELLS_TESTS = "../../tests/compute_cells/*/*/data.yaml";
const COMPUTE_CELLS_AND_KZG_PROOFS_TESTS = "../../tests/compute_cells_and_kzg_proofs/*/*/data.yaml";
const RECOVER_CELLS_AND_KZG_PROOFS_TESTS = "../../tests/recover_cells_and_kzg_proofs/*/*/data.yaml";
const VERIFY_CELL_KZG_PROOF_BATCH_TESTS = "../../tests/verify_cell_kzg_proof_batch/*/*/data.yaml";

const BYTES_PER_FIELD_ELEMENT = 32;

type BlobToKzgCommitmentTest = TestMeta<{blob: string}, string>;
type ComputeKzgProofTest = TestMeta<{blob: string; z: string}, string[]>;
type ComputeBlobKzgProofTest = TestMeta<{blob: string; commitment: string}, string>;
type VerifyKzgProofTest = TestMeta<{commitment: string; y: string; z: string; proof: string}, boolean>;
type VerifyBlobKzgProofTest = TestMeta<{blob: string; commitment: string; proof: string}, boolean>;
type VerifyBatchKzgProofTest = TestMeta<{blobs: string[]; commitments: string[]; proofs: string[]}, boolean>;

type ComputeCellsTest = TestMeta<{blob: string}, string[]>;
type ComputeCellsAndKzgProofsTest = TestMeta<{blob: string}, string[][]>;
type RecoverCellsAndKzgProofsTest = TestMeta<{cell_indices: number[]; cells: string[]}, string[][]>;
type VerifyCellKzgProofBatchTest = TestMeta<
  {commitments: string[]; cell_indices: number[]; cells: string[]; proofs: string[]},
  boolean
>;

const blobValidLength = new Uint8Array(randomBytes(BYTES_PER_BLOB));
const blobBadLength = new Uint8Array(randomBytes(BYTES_PER_BLOB - 1));
const commitmentValidLength = new Uint8Array(randomBytes(BYTES_PER_COMMITMENT));
const commitmentBadLength = new Uint8Array(randomBytes(BYTES_PER_COMMITMENT - 1));
const proofValidLength = new Uint8Array(randomBytes(BYTES_PER_PROOF));
const proofBadLength = new Uint8Array(randomBytes(BYTES_PER_PROOF - 1));
const fieldElementValidLength = new Uint8Array(randomBytes(BYTES_PER_FIELD_ELEMENT));
const fieldElementBadLength = new Uint8Array(randomBytes(BYTES_PER_FIELD_ELEMENT - 1));

/**
 * Generates a random blob of the correct length for the KZG library
 *
 * @return {Uint8Array}
 */
function generateRandomBlob(): Uint8Array {
  return new Uint8Array(
    randomBytes(BYTES_PER_BLOB).map((x, i) => {
      // Set the top byte to be low enough that the field element doesn't overflow the BLS modulus
      if (x > MAX_TOP_BYTE && i % BYTES_PER_FIELD_ELEMENT == 0) {
        return Math.floor(Math.random() * MAX_TOP_BYTE);
      }
      return x;
    })
  );
}

/**
 * Converts hex string to binary Uint8Array
 *
 * @param {string} hexString Hex string to convert
 *
 * @return {Uint8Array}
 */
function bytesFromHex(hexString: string): Uint8Array {
  if (hexString.startsWith("0x")) {
    hexString = hexString.slice(2);
  }
  return Uint8Array.from(Buffer.from(hexString, "hex"));
}

/**
 * Verifies that two Uint8Arrays are bitwise equivalent
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 *
 * @return {void}
 *
 * @throws {Error} If arrays are not equal length or byte values are unequal
 */
function assertBytesEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): void {
  if (a.length !== b.length) {
    throw new Error("unequal Uint8Array lengths");
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`unequal Uint8Array byte at index ${i}`);
  }
}

/**
 * Finds a valid test under a glob path to test files. Filters out tests with
 * "invalid", "incorrect", or "different" in the file name.
 *
 * @param {string} testDir Glob path to test files
 *
 * @return {any} Test object with valid input and output. Must strongly type
 *               results at calling location
 *
 * @throws {Error} If no valid test is found
 */
function getValidTest(testDir: string): any {
  const tests = globSync(testDir);
  const validTest = tests.find(
    (testFile: string) =>
      !testFile.includes("invalid") && !testFile.includes("incorrect") && !testFile.includes("different")
  );
  if (!validTest) throw new Error("Could not find valid test");
  return yaml.load(readFileSync(validTest, "ascii"));
}

/**
 * Runs a suite of tests for the passed function and arguments. Will test base
 * case to ensure a valid set of arguments was passed with the function being
 * tested.  Will then test the same function with an extra, invalid, argument
 * at the end of the argument list to verify extra args are ignored. Checks
 * validity of the extra argument case against the base case. Finally, will
 * check that if an argument is removed that an error is thrown.
 *
 * @param {(...args: any[]) => any} fn Function to be tested
 * @param {any[]} validArgs Valid arguments to be passed as base case to fn
 *
 * @return {void}
 *
 * @throws {Error} If no valid test is found
 */
function testArgCount(fn: (...args: any[]) => any, validArgs: any[]): void {
  const lessArgs = validArgs.slice(0, -1);
  const moreArgs = validArgs.concat("UNKNOWN_ARGUMENT");

  it("should test for different argument lengths", () => {
    expect(lessArgs.length).toBeLessThan(validArgs.length);
    expect(moreArgs.length).toBeGreaterThan(validArgs.length);
  });

  it("should run for expected argument count", () => {
    expect(() => fn(...validArgs)).not.toThrowError();
  });

  it("should ignore extra arguments", () => {
    expect(() => fn(...moreArgs)).not.toThrowError();
  });

  it("should give same result with extra args", () => {
    expect(fn(...validArgs)).toEqual(fn(...moreArgs));
  });

  it("should throw for less than expected argument count", () => {
    expect(() => fn(...lessArgs)).toThrowError();
  });
}

describe("C-KZG", () => {
  beforeAll(async () => {
    loadTrustedSetup(0, TEST_SETUP_FILE_PATH_JSON);
  });

  describe("locating trusted setup file", () => {
    it("should return a txt path if a json file is provided and exists", () => {
      expect(getTrustedSetupFilepath(TEST_SETUP_FILE_PATH_JSON)).toEqual(TEST_SETUP_FILE_PATH_TXT);
    });
    /**
     * No guarantee that the test above runs first, however the json file should
     * have already been loaded by the beforeAll so a valid .txt test setup
     * should be available to expect
     */
    it("should return the same txt path if provided and exists", () => {
      expect(getTrustedSetupFilepath(TEST_SETUP_FILE_PATH_TXT)).toEqual(TEST_SETUP_FILE_PATH_TXT);
    });
    describe("default setups", () => {
      beforeAll(() => {
        if (!existsSync(DEFAULT_TRUSTED_SETUP_PATH)) {
          throw new Error("Default deps/c-kzg/trusted_setup.txt not found for testing");
        }
      });
      it("should return default trusted_setup filepath", () => {
        expect(getTrustedSetupFilepath()).toEqual(DEFAULT_TRUSTED_SETUP_PATH);
      });
    });
  });

  describe("reference tests should pass", () => {
    it("reference tests for blobToKzgCommitment should pass", () => {
      const tests = globSync(BLOB_TO_KZG_COMMITMENT_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: BlobToKzgCommitmentTest = yaml.load(readFileSync(testFile, "ascii"));

        let commitment: Uint8Array;
        const blob = bytesFromHex(test.input.blob);

        try {
          commitment = blobToKzgCommitment(blob);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();
        const expectedCommitment = bytesFromHex(test.output);
        expect(assertBytesEqual(commitment, expectedCommitment));
      });
    });

    it("reference tests for computeKzgProof should pass", () => {
      const tests = globSync(COMPUTE_KZG_PROOF_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: ComputeKzgProofTest = yaml.load(readFileSync(testFile, "ascii"));

        let proof: ProofResult;
        const blob = bytesFromHex(test.input.blob);
        const z = bytesFromHex(test.input.z);

        try {
          proof = computeKzgProof(blob, z);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();

        const [proofBytes, yBytes] = proof;
        const [expectedProofBytes, expectedYBytes] = test.output.map((out) => bytesFromHex(out));

        expect(assertBytesEqual(proofBytes, expectedProofBytes));
        expect(assertBytesEqual(yBytes, expectedYBytes));
      });
    });

    it("reference tests for computeBlobKzgProof should pass", () => {
      const tests = globSync(COMPUTE_BLOB_KZG_PROOF_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: ComputeBlobKzgProofTest = yaml.load(readFileSync(testFile, "ascii"));

        let proof: Uint8Array;
        const blob = bytesFromHex(test.input.blob);
        const commitment = bytesFromHex(test.input.commitment);

        try {
          proof = computeBlobKzgProof(blob, commitment);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();
        const expectedProof = bytesFromHex(test.output);
        expect(assertBytesEqual(proof, expectedProof));
      });
    });

    it("reference tests for verifyKzgProof should pass", () => {
      const tests = globSync(VERIFY_KZG_PROOF_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: VerifyKzgProofTest = yaml.load(readFileSync(testFile, "ascii"));

        let valid;
        const commitment = bytesFromHex(test.input.commitment);
        const z = bytesFromHex(test.input.z);
        const y = bytesFromHex(test.input.y);
        const proof = bytesFromHex(test.input.proof);

        try {
          valid = verifyKzgProof(commitment, z, y, proof);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(valid).toEqual(test.output);
      });
    });

    it("reference tests for verifyBlobKzgProof should pass", () => {
      const tests = globSync(VERIFY_BLOB_KZG_PROOF_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: VerifyBlobKzgProofTest = yaml.load(readFileSync(testFile, "ascii"));

        let valid;
        const blob = bytesFromHex(test.input.blob);
        const commitment = bytesFromHex(test.input.commitment);
        const proof = bytesFromHex(test.input.proof);

        try {
          valid = verifyBlobKzgProof(blob, commitment, proof);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(valid).toEqual(test.output);
      });
    });

    it("reference tests for verifyBlobKzgProofBatch should pass", () => {
      const tests = globSync(VERIFY_BLOB_KZG_PROOF_BATCH_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: VerifyBatchKzgProofTest = yaml.load(readFileSync(testFile, "ascii"));

        let valid;
        const blobs = test.input.blobs.map(bytesFromHex);
        const commitments = test.input.commitments.map(bytesFromHex);
        const proofs = test.input.proofs.map(bytesFromHex);

        try {
          valid = verifyBlobKzgProofBatch(blobs, commitments, proofs);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(valid).toEqual(test.output);
      });
    });

    it("reference tests for computeCells should pass", () => {
      const tests = globSync(COMPUTE_CELLS_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: ComputeCellsTest = yaml.load(readFileSync(testFile, "ascii"));

        let cells;
        const blob = bytesFromHex(test.input.blob);

        try {
          cells = computeCells(blob);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();
        const expectedCells = test.output.map(bytesFromHex);
        expect(cells.length).toBe(expectedCells.length);
        for (let i = 0; i < cells.length; i++) {
          assertBytesEqual(cells[i], expectedCells[i]);
        }
      });
    });

    it("reference tests for computeCellsAndKzgProofs should pass", () => {
      const tests = globSync(COMPUTE_CELLS_AND_KZG_PROOFS_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: ComputeCellsAndKzgProofsTest = yaml.load(readFileSync(testFile, "ascii"));

        let cells;
        let proofs;
        const blob = bytesFromHex(test.input.blob);

        try {
          [cells, proofs] = computeCellsAndKzgProofs(blob);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();
        expect(test.output.length).toBe(2);
        const expectedCells = test.output[0].map(bytesFromHex);
        const expectedProofs = test.output[1].map(bytesFromHex);
        expect(cells.length).toBe(expectedCells.length);
        for (let i = 0; i < cells.length; i++) {
          assertBytesEqual(cells[i], expectedCells[i]);
        }
        expect(proofs.length).toBe(expectedProofs.length);
        for (let i = 0; i < proofs.length; i++) {
          assertBytesEqual(proofs[i], expectedProofs[i]);
        }
      });
    });

    it("reference tests for recoverCellsAndKzgProofs should pass", () => {
      const tests = globSync(RECOVER_CELLS_AND_KZG_PROOFS_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: RecoverCellsAndKzgProofsTest = yaml.load(readFileSync(testFile, "ascii"));

        let recoveredCells;
        let recoveredProofs;
        const cellIndices = test.input.cell_indices;
        const cells = test.input.cells.map(bytesFromHex);

        try {
          [recoveredCells, recoveredProofs] = recoverCellsAndKzgProofs(cellIndices, cells);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(test.output).not.toBeNull();
        expect(test.output.length).toBe(2);
        const expectedCells = test.output[0].map(bytesFromHex);
        const expectedProofs = test.output[1].map(bytesFromHex);
        expect(recoveredCells.length).toBe(expectedCells.length);
        for (let i = 0; i < recoveredCells.length; i++) {
          assertBytesEqual(recoveredCells[i], expectedCells[i]);
        }
        expect(recoveredProofs.length).toBe(expectedProofs.length);
        for (let i = 0; i < recoveredProofs.length; i++) {
          assertBytesEqual(recoveredProofs[i], expectedProofs[i]);
        }
      });
    });

    it("reference tests for verifyCellKzgProofBatch should pass", () => {
      const tests = globSync(VERIFY_CELL_KZG_PROOF_BATCH_TESTS);
      expect(tests.length).toBeGreaterThan(0);

      tests.forEach((testFile: string) => {
        const test: VerifyCellKzgProofBatchTest = yaml.load(readFileSync(testFile, "ascii"));

        let valid;
        const commitments = test.input.commitments.map(bytesFromHex);
        const cellIndices = test.input.cell_indices;
        const cells = test.input.cells.map(bytesFromHex);
        const proofs = test.input.proofs.map(bytesFromHex);

        try {
          valid = verifyCellKzgProofBatch(commitments, cellIndices, cells, proofs);
        } catch {
          expect(test.output).toBeNull();
          return;
        }

        expect(valid).toEqual(test.output);
      });
    });
  });

  describe("edge cases for blobToKzgCommitment", () => {
    describe("check argument count", () => {
      const test: BlobToKzgCommitmentTest = getValidTest(BLOB_TO_KZG_COMMITMENT_TESTS);
      const blob = bytesFromHex(test.input.blob);
      testArgCount(blobToKzgCommitment, [blob]);
    });

    it("throws as expected when given an argument of invalid type", () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      expect(() => blobToKzgCommitment("wrong type")).toThrowError("Expected blob to be a Uint8Array");
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() => blobToKzgCommitment(blobBadLength)).toThrowError("Expected blob to be 131072 bytes");
    });
  });

  // TODO: add more tests for this function.
  describe("edge cases for computeKzgProof", () => {
    describe("check argument count", () => {
      const test: ComputeKzgProofTest = getValidTest(COMPUTE_KZG_PROOF_TESTS);
      const blob = bytesFromHex(test.input.blob);
      const z = bytesFromHex(test.input.z);
      testArgCount(computeKzgProof, [blob, z]);
    });

    it("computes a proof from blob/field element", () => {
      const blob = generateRandomBlob();
      const zBytes = new Uint8Array(BYTES_PER_FIELD_ELEMENT).fill(0);
      computeKzgProof(blob, zBytes);
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() => computeKzgProof(blobBadLength, fieldElementValidLength)).toThrowError(
        "Expected blob to be 131072 bytes"
      );
      expect(() => computeKzgProof(blobValidLength, fieldElementBadLength)).toThrowError(
        "Expected zBytes to be 32 bytes"
      );
    });
  });

  // TODO: add more tests for this function.
  describe("edge cases for computeBlobKzgProof", () => {
    describe("check argument count", () => {
      const test: ComputeBlobKzgProofTest = getValidTest(COMPUTE_BLOB_KZG_PROOF_TESTS);
      const blob = bytesFromHex(test.input.blob);
      const commitment = bytesFromHex(test.input.commitment);
      testArgCount(computeBlobKzgProof, [blob, commitment]);
    });

    it("computes a proof from blob", () => {
      const blob = generateRandomBlob();
      const commitment = blobToKzgCommitment(blob);
      computeBlobKzgProof(blob, commitment);
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() => computeBlobKzgProof(blobBadLength, blobToKzgCommitment(generateRandomBlob()))).toThrowError(
        "Expected blob to be 131072 bytes"
      );
    });
  });

  describe("edge cases for verifyKzgProof", () => {
    describe("check argument count", () => {
      const test: VerifyKzgProofTest = getValidTest(VERIFY_KZG_PROOF_TESTS);
      const commitment = bytesFromHex(test.input.commitment);
      const z = bytesFromHex(test.input.z);
      const y = bytesFromHex(test.input.y);
      const proof = bytesFromHex(test.input.proof);
      testArgCount(verifyKzgProof, [commitment, z, y, proof]);
    });

    it("valid proof should result in true", () => {
      const commitment = new Uint8Array(BYTES_PER_COMMITMENT).fill(0);
      commitment[0] = 0xc0;
      const z = new Uint8Array(BYTES_PER_FIELD_ELEMENT).fill(0);
      const y = new Uint8Array(BYTES_PER_FIELD_ELEMENT).fill(0);
      const proof = new Uint8Array(BYTES_PER_PROOF).fill(0);
      proof[0] = 0xc0;
      expect(verifyKzgProof(commitment, z, y, proof)).toBe(true);
    });

    it("invalid proof should result in false", () => {
      const commitment = new Uint8Array(BYTES_PER_COMMITMENT).fill(0);
      commitment[0] = 0xc0;
      const z = new Uint8Array(BYTES_PER_FIELD_ELEMENT).fill(1);
      const y = new Uint8Array(BYTES_PER_FIELD_ELEMENT).fill(1);
      const proof = new Uint8Array(BYTES_PER_PROOF).fill(0);
      proof[0] = 0xc0;
      expect(verifyKzgProof(commitment, z, y, proof)).toBe(false);
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() =>
        verifyKzgProof(commitmentBadLength, fieldElementValidLength, fieldElementValidLength, proofValidLength)
      ).toThrowError("Expected commitmentBytes to be 48 bytes");
      expect(() =>
        verifyKzgProof(commitmentValidLength, fieldElementBadLength, fieldElementValidLength, proofValidLength)
      ).toThrowError("Expected zBytes to be 32 bytes");
      expect(() =>
        verifyKzgProof(commitmentValidLength, fieldElementValidLength, fieldElementBadLength, proofValidLength)
      ).toThrowError("Expected yBytes to be 32 bytes");
      expect(() =>
        verifyKzgProof(commitmentValidLength, fieldElementValidLength, fieldElementValidLength, proofBadLength)
      ).toThrowError("Expected proofBytes to be 48 bytes");
    });
  });

  describe("edge cases for verifyBlobKzgProof", () => {
    describe("check argument count", () => {
      const test: VerifyBlobKzgProofTest = getValidTest(VERIFY_BLOB_KZG_PROOF_TESTS);
      const blob = bytesFromHex(test.input.blob);
      const commitment = bytesFromHex(test.input.commitment);
      const proof = bytesFromHex(test.input.proof);
      testArgCount(verifyBlobKzgProof, [blob, commitment, proof]);
    });

    it("correct blob/commitment/proof should verify as true", () => {
      const blob = generateRandomBlob();
      const commitment = blobToKzgCommitment(blob);
      const proof = computeBlobKzgProof(blob, commitment);
      expect(verifyBlobKzgProof(blob, commitment, proof)).toBe(true);
    });

    it("incorrect commitment should verify as false", () => {
      const blob = generateRandomBlob();
      const commitment = blobToKzgCommitment(generateRandomBlob());
      const proof = computeBlobKzgProof(blob, commitment);
      expect(verifyBlobKzgProof(blob, commitment, proof)).toBe(false);
    });

    it("incorrect proof should verify as false", () => {
      const blob = generateRandomBlob();
      const commitment = blobToKzgCommitment(blob);
      const randomBlob = generateRandomBlob();
      const randomCommitment = blobToKzgCommitment(randomBlob);
      const proof = computeBlobKzgProof(randomBlob, randomCommitment);
      expect(verifyBlobKzgProof(blob, commitment, proof)).toBe(false);
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() => verifyBlobKzgProof(blobBadLength, commitmentValidLength, proofValidLength)).toThrowError(
        "Expected blob to be 131072 bytes"
      );
      expect(() => verifyBlobKzgProof(blobValidLength, commitmentBadLength, proofValidLength)).toThrowError(
        "Expected commitmentBytes to be 48 bytes"
      );
      expect(() => verifyBlobKzgProof(blobValidLength, commitmentValidLength, proofBadLength)).toThrowError(
        "Expected proofBytes to be 48 bytes"
      );
    });
  });

  describe("edge cases for verifyBlobKzgProofBatch", () => {
    describe("check argument count", () => {
      const test: VerifyBatchKzgProofTest = getValidTest(VERIFY_BLOB_KZG_PROOF_BATCH_TESTS);
      const blobs = test.input.blobs.map(bytesFromHex);
      const commitments = test.input.commitments.map(bytesFromHex);
      const proofs = test.input.proofs.map(bytesFromHex);
      testArgCount(verifyBlobKzgProofBatch, [blobs, commitments, proofs]);
    });

    it("should reject non-array args", () => {
      expect(() =>
        verifyBlobKzgProofBatch(
          2 as unknown as Uint8Array[],
          [commitmentValidLength, commitmentValidLength],
          [proofValidLength, proofValidLength]
        )
      ).toThrowError("Blobs, commitments, and proofs must all be arrays");
    });

    it("should reject non-bytearray blob", () => {
      expect(() =>
        verifyBlobKzgProofBatch(
          ["foo", "bar"] as unknown as Uint8Array[],
          [commitmentValidLength, commitmentValidLength],
          [proofValidLength, proofValidLength]
        )
      ).toThrowError("Expected blob to be a Uint8Array");
    });

    it("throws as expected when given an argument of invalid length", () => {
      expect(() =>
        verifyBlobKzgProofBatch(
          [blobBadLength, blobValidLength],
          [commitmentValidLength, commitmentValidLength],
          [proofValidLength, proofValidLength]
        )
      ).toThrowError("Expected blob to be 131072 bytes");
      expect(() =>
        verifyBlobKzgProofBatch(
          [blobValidLength, blobValidLength],
          [commitmentBadLength, commitmentValidLength],
          [proofValidLength, proofValidLength]
        )
      ).toThrowError("Expected commitmentBytes to be 48 bytes");
      expect(() =>
        verifyBlobKzgProofBatch(
          [blobValidLength, blobValidLength],
          [commitmentValidLength, commitmentValidLength],
          [proofValidLength, proofBadLength]
        )
      ).toThrowError("Expected proofBytes to be 48 bytes");
    });

    it("zero blobs/commitments/proofs should verify as true", () => {
      expect(verifyBlobKzgProofBatch([], [], [])).toBe(true);
    });

    it("mismatching blobs/commitments/proofs should throw error", () => {
      const count = 3;
      const blobs = new Array(count);
      const commitments = new Array(count);
      const proofs = new Array(count);
      for (const [i] of blobs.entries()) {
        blobs[i] = generateRandomBlob();
        commitments[i] = blobToKzgCommitment(blobs[i]);
        proofs[i] = computeBlobKzgProof(blobs[i], commitments[i]);
      }
      expect(verifyBlobKzgProofBatch(blobs, commitments, proofs)).toBe(true);
      expect(() => verifyBlobKzgProofBatch(blobs.slice(0, 1), commitments, proofs)).toThrowError(
        "Requires equal number of blobs/commitments/proofs"
      );
      expect(() => verifyBlobKzgProofBatch(blobs, commitments.slice(0, 1), proofs)).toThrowError(
        "Requires equal number of blobs/commitments/proofs"
      );
      expect(() => verifyBlobKzgProofBatch(blobs, commitments, proofs.slice(0, 1))).toThrowError(
        "Requires equal number of blobs/commitments/proofs"
      );
    });
  });
});
