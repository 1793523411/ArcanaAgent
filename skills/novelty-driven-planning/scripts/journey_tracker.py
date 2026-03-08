#!/usr/bin/env python3
"""
Exploration Journey Tracker

Track stepping stones, discoveries, and novelty scores throughout an exploration journey.
Helps identify patterns, serendipitous connections, and the evolution of the adjacent possible.
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


class JourneyTracker:
    def __init__(self, journey_file: Path = Path(".exploration_journey.json")):
        self.journey_file = journey_file
        self.journey = self._load_journey()

    def _load_journey(self) -> Dict:
        if self.journey_file.exists():
            with open(self.journey_file, 'r') as f:
                return json.load(f)
        return {
            "metadata": {
                "name": "Unnamed Journey",
                "started": datetime.now().isoformat(),
                "status": "active"
            },
            "stones": []
        }

    def _save_journey(self):
        with open(self.journey_file, 'w') as f:
            json.dump(self.journey, f, indent=2)

    def add_stone(self, name: str, discovery: str, novelty: int, 
                  opens: Optional[str] = None, capabilities: Optional[str] = None,
                  surprises: Optional[str] = None):
        stone = {
            "id": len(self.journey["stones"]) + 1,
            "name": name,
            "date": datetime.now().isoformat(),
            "discovery": discovery,
            "novelty_score": novelty,
            "opens": opens or "Not specified",
            "capabilities": capabilities or "Not specified",
            "surprises": surprises or "None noted"
        }
        
        self.journey["stones"].append(stone)
        self._save_journey()
        
        print(f"✅ Added stepping stone #{stone['id']}: {name}")
        print(f"   Novelty: {novelty}/10")
        print(f"   Discovery: {discovery}")

    def view_journey(self, detailed: bool = False):
        metadata = self.journey["metadata"]
        stones = self.journey["stones"]
        
        print(f"\n{'='*70}")
        print(f"🧭 Exploration Journey: {metadata['name']}")
        print(f"{'='*70}")
        print(f"Started: {metadata['started']}")
        print(f"Status: {metadata['status']}")
        print(f"Stepping Stones: {len(stones)}")
        
        if not stones:
            print("\nNo stepping stones recorded yet.")
            return
        
        avg_novelty = sum(s["novelty_score"] for s in stones) / len(stones)
        print(f"Average Novelty: {avg_novelty:.1f}/10")
        print(f"\n{'='*70}")
        
        for stone in stones:
            print(f"\n#{stone['id']}: {stone['name']}")
            print(f"  Date: {stone['date'][:10]}")
            print(f"  Novelty: {stone['novelty_score']}/10")
            print(f"  Discovery: {stone['discovery']}")
            
            if detailed:
                print(f"  Opens: {stone['opens']}")
                print(f"  Capabilities: {stone['capabilities']}")
                print(f"  Surprises: {stone['surprises']}")
        
        print(f"\n{'='*70}")

    def analyze_journey(self):
        stones = self.journey["stones"]
        
        if len(stones) < 2:
            print("Need at least 2 stepping stones to analyze patterns.")
            return
        
        print(f"\n{'='*70}")
        print(f"📊 Journey Analysis")
        print(f"{'='*70}")
        
        novelty_scores = [s["novelty_score"] for s in stones]
        avg_novelty = sum(novelty_scores) / len(novelty_scores)
        
        print(f"\n📈 Novelty Trend")
        print(f"  Average: {avg_novelty:.1f}/10")
        print(f"  Range: {min(novelty_scores)} - {max(novelty_scores)}")
        
        print(f"\n  Timeline:")
        for i, stone in enumerate(stones):
            score = stone["novelty_score"]
            bar = "█" * score + "░" * (10 - score)
            
            if i > 0:
                prev_score = stones[i-1]["novelty_score"]
                if score > prev_score:
                    trend = "↑"
                elif score < prev_score:
                    trend = "↓"
                else:
                    trend = "→"
            else:
                trend = " "
            
            print(f"  {stone['id']:2d}. {bar} {score:2d}/10 {trend} {stone['name'][:40]}")
        
        print(f"\n🎯 Journey Health")
        
        if avg_novelty >= 7:
            health = "Excellent"
            emoji = "🟢"
        elif avg_novelty >= 5:
            health = "Good"
            emoji = "🟡"
        else:
            health = "Needs attention"
            emoji = "🔴"
        
        print(f"  {emoji} Overall Health: {health}")
        
        if novelty_scores[-1] < novelty_scores[0] - 2:
            print(f"  ⚠️  Warning: Novelty declining significantly")
            print(f"     Consider exploring more radical directions")
        
        if avg_novelty < 5:
            print(f"  ⚠️  Warning: Low average novelty")
            print(f"     You may be in exploitation mode - consider more exploration")
        
        recent_stones = stones[-3:] if len(stones) >= 3 else stones
        recent_avg = sum(s["novelty_score"] for s in recent_stones) / len(recent_stones)
        
        print(f"\n🔍 Recent Activity (last {len(recent_stones)} stones)")
        print(f"  Recent average novelty: {recent_avg:.1f}/10")
        
        if recent_avg > avg_novelty:
            print(f"  ✅ Novelty increasing - good exploration momentum")
        elif recent_avg < avg_novelty - 1:
            print(f"  ⚠️  Novelty decreasing - consider new directions")
        
        print(f"\n💡 Insights")
        high_novelty = [s for s in stones if s["novelty_score"] >= 7]
        if high_novelty:
            print(f"  • {len(high_novelty)} high-novelty stones (7+/10)")
            print(f"    Most novel: #{high_novelty[-1]['id']} - {high_novelty[-1]['name']}")
        
        surprises = [s for s in stones if s["surprises"] != "None noted"]
        if surprises:
            print(f"  • {len(surprises)} stones with noted surprises")
        
        print(f"\n{'='*70}")

    def set_metadata(self, name: Optional[str] = None, status: Optional[str] = None):
        if name:
            self.journey["metadata"]["name"] = name
        if status:
            self.journey["metadata"]["status"] = status
        self._save_journey()
        print(f"✅ Updated journey metadata")

    def export_markdown(self, output_file: Path):
        metadata = self.journey["metadata"]
        stones = self.journey["stones"]
        
        md = f"""# Exploration Journey: {metadata['name']}

**Started**: {metadata['started'][:10]}  
**Status**: {metadata['status']}  
**Stepping Stones**: {len(stones)}

---

## Stepping Stones

"""
        
        for stone in stones:
            md += f"""### Stone {stone['id']}: {stone['name']}

**Date**: {stone['date'][:10]}  
**Novelty Score**: {stone['novelty_score']}/10

**Discovery**: {stone['discovery']}

**Opens**: {stone['opens']}

**Capabilities Built**: {stone['capabilities']}

**Surprises**: {stone['surprises']}

---

"""
        
        if stones:
            avg_novelty = sum(s["novelty_score"] for s in stones) / len(stones)
            md += f"""## Journey Statistics

- **Total Stones**: {len(stones)}
- **Average Novelty**: {avg_novelty:.1f}/10
- **Date Range**: {stones[0]['date'][:10]} to {stones[-1]['date'][:10]}

"""
        
        with open(output_file, 'w') as f:
            f.write(md)
        
        print(f"✅ Exported journey to {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Track exploration journey stepping stones",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Add a stepping stone
  python journey_tracker.py add \\
    --stone "Implemented caching layer" \\
    --discovery "Data access patterns are highly predictable" \\
    --novelty 7 \\
    --opens "Could explore predictive prefetching"

  # View journey timeline
  python journey_tracker.py view

  # Analyze journey patterns
  python journey_tracker.py analyze

  # Set journey name
  python journey_tracker.py meta --name "Architecture Evolution"

  # Export to markdown
  python journey_tracker.py export journey.md
        """
    )
    
    parser.add_argument(
        "command",
        choices=["add", "view", "analyze", "meta", "export"],
        help="Command to execute"
    )
    
    parser.add_argument("--stone", help="Name of the stepping stone")
    parser.add_argument("--discovery", help="What you discovered")
    parser.add_argument("--novelty", type=int, help="Novelty score (0-10)")
    parser.add_argument("--opens", help="What new possibilities this opens")
    parser.add_argument("--capabilities", help="What capabilities were built")
    parser.add_argument("--surprises", help="Any surprises encountered")
    
    parser.add_argument("--name", help="Journey name (for meta command)")
    parser.add_argument("--status", help="Journey status (for meta command)")
    
    parser.add_argument("--detailed", action="store_true", help="Show detailed view")
    parser.add_argument("--file", help="Journey file path")
    parser.add_argument("output", nargs="?", help="Output file (for export)")
    
    args = parser.parse_args()
    
    journey_file = Path(args.file) if args.file else Path(".exploration_journey.json")
    tracker = JourneyTracker(journey_file)
    
    if args.command == "add":
        if not all([args.stone, args.discovery, args.novelty is not None]):
            parser.error("add requires --stone, --discovery, and --novelty")
        
        if not 0 <= args.novelty <= 10:
            parser.error("novelty must be between 0 and 10")
        
        tracker.add_stone(
            args.stone,
            args.discovery,
            args.novelty,
            args.opens,
            args.capabilities,
            args.surprises
        )
    
    elif args.command == "view":
        tracker.view_journey(detailed=args.detailed)
    
    elif args.command == "analyze":
        tracker.analyze_journey()
    
    elif args.command == "meta":
        if not any([args.name, args.status]):
            parser.error("meta requires --name and/or --status")
        tracker.set_metadata(args.name, args.status)
    
    elif args.command == "export":
        if not args.output:
            parser.error("export requires an output filename")
        tracker.export_markdown(Path(args.output))


if __name__ == "__main__":
    main()
