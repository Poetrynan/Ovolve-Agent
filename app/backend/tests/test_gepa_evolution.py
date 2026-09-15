"""Unit tests for the GEPA Reflective Prompt & Skill Evolution Engine."""
import pytest
from gepa_evolution import (
    FitnessVector,
    GenomeCandidate,
    compute_pareto_front,
    ReflectiveMutator,
    GEPAEvolutionOptimizer,
)
from evolution import EvolutionEngine, EvolutionStore, MODE_ACTIVE


def test_fitness_vector_dominance():
    v1 = FitnessVector(success_rate=0.9, token_efficiency=0.8, latency_score=0.7, safety_score=1.0)
    v2 = FitnessVector(success_rate=0.8, token_efficiency=0.7, latency_score=0.6, safety_score=1.0)
    v3 = FitnessVector(success_rate=0.95, token_efficiency=0.5, latency_score=0.9, safety_score=1.0)

    # v1 dominates v2 because all dimensions of v1 are >= v2 and some strictly greater
    assert v1.dominates(v2) is True
    assert v2.dominates(v1) is False

    # v1 and v3 are non-dominated (trade-off between token_efficiency and success_rate)
    assert v1.dominates(v3) is False
    assert v3.dominates(v1) is False


def test_compute_pareto_front():
    c1 = GenomeCandidate(
        candidate_id="c1", generation=1, name="cand1", prompt_content="prompt 1",
        fitness=FitnessVector(success_rate=0.9, token_efficiency=0.8, latency_score=0.7, safety_score=1.0)
    )
    c2 = GenomeCandidate(
        candidate_id="c2", generation=1, name="cand2", prompt_content="prompt 2",
        fitness=FitnessVector(success_rate=0.7, token_efficiency=0.6, latency_score=0.5, safety_score=0.9)
    )
    c3 = GenomeCandidate(
        candidate_id="c3", generation=1, name="cand3", prompt_content="prompt 3",
        fitness=FitnessVector(success_rate=0.95, token_efficiency=0.5, latency_score=0.9, safety_score=1.0)
    )

    # c2 is dominated by c1; c1 and c3 form the Pareto front
    front = compute_pareto_front([c1, c2, c3])
    front_ids = [c.candidate_id for c in front]
    assert "c1" in front_ids
    assert "c3" in front_ids
    assert "c2" not in front_ids


def test_reflective_mutator_diagnosis():
    mutator = ReflectiveMutator()
    
    # Permission error trace
    perm_trace = {"tool": "write_file", "error": "Access denied: cannot write to readonly path"}
    diag1 = mutator.diagnose_failure_trace(perm_trace)
    assert diag1["root_cause"] == "permission_denied"
    assert "受保护" in diag1["suggested_guardrail"]

    # Timeout error trace
    timeout_trace = {"tool": "pytest", "error": "command execution timed out after 30s"}
    diag2 = mutator.diagnose_failure_trace(timeout_trace)
    assert diag2["root_cause"] == "timeout_exhaustion"


def test_reflective_mutation_and_crossover():
    mutator = ReflectiveMutator()
    parent_a = GenomeCandidate(
        candidate_id="parent_a", generation=0, name="seed_a",
        prompt_content="Use Python for data analysis.",
        steps=["1. Load dataset", "2. Clean rows"],
        guardrails=["Do not delete raw files"],
    )
    parent_b = GenomeCandidate(
        candidate_id="parent_b", generation=0, name="seed_b",
        prompt_content="Use Pandas and verify schemas.",
        steps=["1. Verify schemas", "2. Run pipeline"],
        guardrails=["Check memory limits"],
    )

    traces = [
        {"tool": "load_data", "error": "Access denied: file is readonly"},
    ]
    mutant = mutator.mutate_prompt(parent_a, traces, generation=1)
    assert mutant.generation == 1
    assert any("受保护" in g for g in mutant.guardrails)
    assert "GEPA 自进化安全守则" in mutant.prompt_content

    child = mutator.crossover(parent_a, parent_b, generation=1)
    assert len(child.steps) >= 3
    assert len(child.guardrails) >= 2


def test_gepa_evolution_cycle_run():
    optimizer = GEPAEvolutionOptimizer()
    seed_prompt = "Execute user software engineering commands."
    eval_cases = [
        {"input": "Read config", "expected_guardrail": "受保护", "base_tokens": 120, "base_steps": 2},
        {"input": "Write code", "base_tokens": 300, "base_steps": 4},
    ]
    failure_traces = [
        {"tool": "write_file", "error": "Access denied: cannot write to readonly path AGENTS.md"},
    ]

    res = optimizer.run_evolution_cycle(
        seed_prompt=seed_prompt,
        seed_name="coder_prompt",
        eval_cases=eval_cases,
        failure_traces=failure_traces,
        max_generations=2,
        population_size=4,
    )

    assert "winner" in res
    assert "paretoFront" in res
    assert len(res["paretoFront"]) >= 1
    winner = res["winner"]
    assert "GEPA 自进化安全守则" in winner["promptContent"]


def test_evolution_engine_user_correction_and_gepa(tmp_path):
    store = EvolutionStore(db_path=str(tmp_path / "evolution_test.db"))
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(tmp_path))

    # Test user correction recording
    sig = engine.record_user_correction(
        turn_id="turn-5",
        correction_text="Do not use yarn, use npm instead",
        session_id="sess-abc",
    )
    assert sig is not None

    # Test GEPA optimization via engine
    opt_res = engine.gepa_optimize_prompt(
        seed_prompt="Build TypeScript bundle",
        seed_name="builder",
        eval_cases=[{"input": "build", "base_tokens": 100}],
        failure_traces=[{"tool": "npm", "error": "Access denied"}],
        max_generations=1,
    )
    assert "winner" in opt_res
