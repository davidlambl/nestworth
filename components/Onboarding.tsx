import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ScrollView,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';

const { width } = Dimensions.get('window');

interface OnboardingProps {
  onComplete: () => void;
}

const STEPS = [
  {
    icon: 'bank' as const,
    title: 'Track Your Accounts',
    description:
      'Add checking, savings, credit cards, and cash accounts. See your balances at a glance.',
  },
  {
    icon: 'pencil-square-o' as const,
    title: 'Log Transactions',
    description:
      'Record checks, deposits, and purchases with smart autocomplete and auto-incrementing check numbers.',
  },
  {
    icon: 'refresh' as const,
    title: 'Sync Everywhere',
    description:
      'Your data syncs in real-time across iPhone, iPad, and web browsers. Always up to date.',
  },
  {
    icon: 'bar-chart' as const,
    title: 'Reports & Insights',
    description:
      'See where your money goes with income vs. expense reports and spending trends.',
  },
];

export function Onboarding({ onComplete }: OnboardingProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const [step, setStep] = useState(0);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.tintLight }]}>
          <FontAwesome name={current.icon} size={48} color={colors.tint} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>{current.title}</Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {current.description}
        </Text>
      </View>

      <View style={styles.dots}>
        {STEPS.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === step ? colors.tint : colors.border,
                width: i === step ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.buttons}>
        {step > 0 && (
          <TouchableOpacity
            style={[styles.backBtn, { borderColor: colors.border }]}
            onPress={() => setStep(step - 1)}
          >
            <Text style={[styles.backBtnText, { color: colors.text }]}>Back</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.nextBtn, { backgroundColor: colors.tint }]}
          onPress={() => {
            if (isLast) {
              onComplete();
            } else {
              setStep(step + 1);
            }
          }}
        >
          <Text style={styles.nextBtnText}>
            {isLast ? 'Get Started' : 'Next'}
          </Text>
        </TouchableOpacity>
      </View>

      {!isLast && (
        <TouchableOpacity style={styles.skipBtn} onPress={onComplete}>
          <Text style={[styles.skipBtnText, { color: colors.placeholder }]}>
            Skip
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  content: {
    alignItems: 'center',
    marginBottom: 48,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  description: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 320,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 48,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
  },
  backBtn: {
    flex: 1,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  backBtnText: { fontSize: 17, fontWeight: '600' },
  nextBtn: {
    flex: 2,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  skipBtn: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 8,
  },
  skipBtnText: { fontSize: 15 },
});
